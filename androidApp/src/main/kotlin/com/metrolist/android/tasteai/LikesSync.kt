/**
 * Music AI (fork of Metrolist) — shared liked songs through the Pi
 * Licensed under GPL-3.0
 *
 * Keeps this phone's liked songs the same as the Mac's:
 * - likes made here that the Pi doesn't know yet are sent to it
 * - likes (and unlikes) from other devices are applied to this phone's library
 */

package com.metrolist.android.tasteai

import android.content.Context
import com.metrolist.shared.db.MusicDatabase
import com.metrolist.shared.model.ArtistTiny
import com.metrolist.shared.model.SongItem
import com.metrolist.shared.settings.Settings
import com.metrolist.shared.state.SongLikeState
import io.ktor.client.call.body
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import timber.log.Timber
import java.util.concurrent.ConcurrentHashMap

@Serializable
private data class RemoteLike(
    val id: String,
    val title: String? = null,
    val artists: List<String> = emptyList(),
    val album: String? = null,
    val duration: Int? = null,
    val likedAt: Long = 0,
)

@Serializable
private data class RemoteUnlike(
    val id: String,
    val at: Long = 0,
)

@Serializable
private data class LikesResponse(
    val likes: List<RemoteLike> = emptyList(),
    val unliked: List<RemoteUnlike> = emptyList(),
)

class LikesSync(
    context: Context,
    private val scope: CoroutineScope,
    private val database: MusicDatabase,
    private val tasteAi: TasteAiManager,
    private val currentSongId: () -> String?,
) {
    // Metrolist keeps no like date, so remember when each like was first seen here.
    private val likedAt = context.getSharedPreferences("musicai_likes", Context.MODE_PRIVATE)

    fun start() {
        // Like / unlike of the playing song counts as a taste signal.
        scope.launch {
            var known: Set<String>? = null
            SongLikeState.likedSongsFlow.collect { songs ->
                val ids = songs.mapTo(hashSetOf(), SongItem::id)
                val previous = known
                known = ids
                rememberLikeTimes(ids)
                if (previous == null) return@collect
                val current = currentSongId() ?: return@collect
                val fromSync = suppressed.remove(current) != null
                if (fromSync) return@collect
                if (current in ids && current !in previous) {
                    songs.firstOrNull { it.id == current }?.let { tasteAi.onLikeChanged(it, liked = true) }
                } else if (current !in ids && current in previous) {
                    tasteAi.onLikeChanged(SongItem(current, "", null, emptyList(), null), liked = false)
                }
            }
        }
        scope.launch(Dispatchers.IO) {
            delay(8_000)
            var round = 0
            while (isActive) {
                runCatching { syncOnce() }.onFailure {
                    Timber.tag(TAG).d("likes sync skipped: ${it.message}")
                    PiAddress.onRequestFailed()
                }
                // Keep the AI mixes on the Playlists page up to date: at app start, then about every 6 hours.
                if (round % MIXES_EVERY_ROUNDS == 0) {
                    runCatching {
                        val url = MusicAiHttp.serverUrl
                        if (url.isNotBlank()) AiMixes.refresh(database, url)
                    }.onFailure { Timber.tag(TAG).d("mixes refresh skipped: ${it.message}") }
                }
                round++
                delay(INTERVAL_MS)
            }
        }
    }

    private fun rememberLikeTimes(ids: Set<String>) {
        val now = System.currentTimeMillis()
        val stored = likedAt.all.keys
        val editor = likedAt.edit()
        ids.filterNot { it in stored }.forEach { editor.putLong(it, now) }
        stored.filterNot { it in ids }.forEach { editor.remove(it) }
        editor.apply()
    }

    private fun likedTime(song: SongItem): Long = likedAt.getLong(song.id, 0L)

    private suspend fun syncOnce() {
        if (!Settings.shared.tasteAiEnabled) return
        val url = MusicAiHttp.serverUrl
        if (url.isBlank()) return

        val res = MusicAiHttp.client.get("$url/likes") { timeout { requestTimeoutMillis = 15_000 } }
        if (!res.status.isSuccess()) return
        val remote = res.body<LikesResponse>()
        val remoteIds = remote.likes.mapTo(hashSetOf()) { it.id }
        val unlikedAt = remote.unliked.associate { it.id to it.at }
        val local = SongLikeState.likedSongsFlow.value.filterNot { it.isLocal }

        // 1. Likes made on this phone that the Pi doesn't know about yet.
        val toUpload =
            local.filter { song ->
                val unliked = unlikedAt[song.id]
                song.id !in remoteIds && (unliked == null || likedTime(song) > unliked)
            }
        toUpload.chunked(100).forEach { batch ->
            MusicAiHttp.client.post("$url/events") {
                contentType(ContentType.Application.Json)
                setBody(
                    EventsRequest(
                        batch.map { song ->
                            TasteEvent(
                                type = "like",
                                track = song.toTasteTrack(),
                                ts = likedTime(song).takeIf { it > 0 } ?: System.currentTimeMillis(),
                            )
                        },
                    ),
                )
            }
        }

        // 2. Songs unliked on another device after they were liked here.
        val toUnlike = local.filter { song -> unlikedAt[song.id]?.let { it > likedTime(song) } == true }.map { it.id }

        // 3. Songs liked on another device.
        val localIds = local.mapTo(hashSetOf()) { it.id }
        val toLike =
            remote.likes.filter { it.id !in localIds }.map { like ->
                SongItem(
                    id = like.id,
                    title = like.title.orEmpty(),
                    thumbnail = thumbnailFor(like.id),
                    artists = like.artists.map { ArtistTiny(id = null, name = it) },
                    album = null,
                    duration = like.duration?.toLong()?.takeIf { it > 0 },
                )
            }

        if (toUnlike.isEmpty() && toLike.isEmpty()) return
        withContext(Dispatchers.Main) {
            toUnlike.forEach { suppressed[it] = true }
            toLike.forEach { suppressed[it.id] = true }
            if (toUnlike.isNotEmpty()) SongLikeState.removeLikes(toUnlike)
            if (toLike.isNotEmpty()) SongLikeState.addLikes(toLike)
            Unit
        }
        val editor = likedAt.edit()
        remote.likes.filter { it.id !in localIds && it.likedAt > 0 }.forEach { editor.putLong(it.id, it.likedAt) }
        editor.apply()
    }

    companion object {
        private const val TAG = "LikesSync"
        private const val INTERVAL_MS = 120_000L
        private const val MIXES_EVERY_ROUNDS = 180

        /** Songs whose liked state was just changed by a sync: don't report those back as new likes. */
        val suppressed = ConcurrentHashMap<String, Boolean>()
    }
}
