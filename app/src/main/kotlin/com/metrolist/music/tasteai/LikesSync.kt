/**
 * Music AI (fork of Metrolist) — shared liked songs through the Pi
 * Licensed under GPL-3.0
 *
 * Keeps this phone's liked songs the same as the Mac's:
 * - likes made here that the Pi doesn't know yet are sent to it
 * - likes (and unlikes) from other devices are applied to this phone's library
 */

package com.metrolist.music.tasteai

import android.content.Context
import com.metrolist.music.constants.TasteAiEnabledKey
import com.metrolist.music.constants.TasteAiUrlKey
import com.metrolist.music.db.MusicDatabase
import com.metrolist.music.models.MediaMetadata
import com.metrolist.music.utils.dataStore
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import timber.log.Timber
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
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
private data class RemoteUnlike(val id: String, val at: Long = 0)

@Serializable
private data class LikesResponse(
    val likes: List<RemoteLike> = emptyList(),
    val unliked: List<RemoteUnlike> = emptyList(),
)

@Serializable
private data class LikeEventsRequest(val events: List<TasteEvent>)

class LikesSync(
    private val context: Context,
    private val scope: CoroutineScope,
    private val database: MusicDatabase,
) {
    fun start() {
        scope.launch(Dispatchers.IO) {
            delay(8_000)
            while (isActive) {
                runCatching { syncOnce() }.onFailure { Timber.tag(TAG).d("likes sync skipped: ${it.message}") }
                delay(INTERVAL_MS)
            }
        }
    }

    private suspend fun syncOnce() {
        val prefs = context.dataStore.data.first()
        if (prefs[TasteAiEnabledKey] != true) return
        val url = (prefs[TasteAiUrlKey] ?: "").trim().trimEnd('/')
        if (url.isBlank()) return

        val res = client.get("$url/likes")
        if (!res.status.isSuccess()) return
        val remote = res.body<LikesResponse>()
        val remoteIds = remote.likes.map { it.id }.toSet()
        val unlikedAt = remote.unliked.associate { it.id to it.at }

        val local = database.likedSongsByRowIdAsc().first()
        val zone = ZoneId.systemDefault()
        fun millis(date: LocalDateTime?) = date?.atZone(zone)?.toInstant()?.toEpochMilli() ?: 0L

        // 1. Likes made on this phone that the Pi doesn't know about yet.
        val toUpload =
            local.filter { song ->
                val unliked = unlikedAt[song.id]
                song.id !in remoteIds && (unliked == null || millis(song.song.likedDate) > unliked)
            }
        toUpload.chunked(100).forEach { batch ->
            client.post("$url/events") {
                contentType(ContentType.Application.Json)
                setBody(
                    LikeEventsRequest(
                        batch.map { song ->
                            TasteEvent(
                                type = "like",
                                track =
                                    TasteTrack(
                                        id = song.id,
                                        title = song.song.title,
                                        artists = song.artists.map { it.name },
                                        album = song.album?.title,
                                        duration = song.song.duration,
                                    ),
                                ts = millis(song.song.likedDate).takeIf { it > 0 } ?: System.currentTimeMillis(),
                            )
                        },
                    ),
                )
            }
        }

        // 2. Songs unliked on another device after they were liked here.
        local.forEach { song ->
            val unliked = unlikedAt[song.id] ?: return@forEach
            if (unliked > millis(song.song.likedDate)) {
                suppressed[song.id] = true
                database.update(song.song.copy(liked = false, likedDate = null))
            }
        }

        // 3. Songs liked on another device.
        val localIds = local.map { it.id }.toSet()
        remote.likes.filter { it.id !in localIds }.forEach { like ->
            val existing = database.getSongByIdBlocking(like.id)
            if (existing == null) {
                database.insert(
                    MediaMetadata(
                        id = like.id,
                        title = like.title ?: "",
                        artists = like.artists.map { MediaMetadata.Artist(id = null, name = it) },
                        duration = like.duration ?: -1,
                        thumbnailUrl = "https://i.ytimg.com/vi/${like.id}/hqdefault.jpg",
                    ),
                )
            }
            val song = database.getSongByIdBlocking(like.id)?.song ?: return@forEach
            val date =
                if (like.likedAt > 0) LocalDateTime.ofInstant(Instant.ofEpochMilli(like.likedAt), zone) else LocalDateTime.now()
            suppressed[like.id] = true
            database.update(song.copy(liked = true, likedDate = date))
        }
    }

    companion object {
        private const val TAG = "LikesSync"
        private const val INTERVAL_MS = 120_000L

        /** Songs whose liked state was just changed by a sync: don't report those back as new likes. */
        val suppressed = ConcurrentHashMap<String, Boolean>()

        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        private val client by lazy {
            HttpClient(OkHttp) {
                install(ContentNegotiation) { json(json) }
                install(HttpTimeout) {
                    connectTimeoutMillis = 4_000
                    requestTimeoutMillis = 15_000
                }
                expectSuccess = false
            }
        }
    }
}
