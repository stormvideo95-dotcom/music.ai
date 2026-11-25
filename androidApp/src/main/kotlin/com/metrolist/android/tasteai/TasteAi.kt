/**
 * Music AI (fork of Metrolist) — Taste AI
 * Licensed under GPL-3.0
 *
 * Talks to Storm's own taste server (Umbrel / Raspberry Pi 5).
 * - Sends listening events (complete / skip / like / unlike)
 * - Reorders the songs Metrolist picks to continue a finished queue, best taste match first.
 * If the Pi can't be reached, Metrolist's own order is kept.
 */

package com.metrolist.android.tasteai

import com.metrolist.shared.model.SongItem
import com.metrolist.shared.model.isPodcast
import com.metrolist.shared.settings.Settings
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.timeout
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import timber.log.Timber

@Serializable
data class TasteTrack(
    val id: String,
    val title: String,
    val artists: List<String> = emptyList(),
    val album: String? = null,
    val duration: Int = 0,
)

@Serializable
data class TasteEvent(
    val type: String,
    val track: TasteTrack,
    val ts: Long,
    val listenedMs: Long = 0,
)

@Serializable
internal data class EventsRequest(
    val events: List<TasteEvent>,
)

@Serializable
private data class RankRequest(
    val candidates: List<TasteTrack>,
    val recent: List<String>,
    val count: Int,
)

@Serializable
private data class RankResponse(
    val ids: List<String> = emptyList(),
)

@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val events: Int = 0,
    val trained: Boolean = false,
)

@Serializable
data class MixSong(
    val id: String,
    val title: String = "",
    val artists: List<String> = emptyList(),
    val album: String? = null,
    val duration: Int = 0,
)

@Serializable
data class Mix(
    val name: String,
    val songs: List<MixSong> = emptyList(),
)

@Serializable
data class MixesResponse(
    val ready: Boolean = false,
    val likedSongs: Int = 0,
    val needed: Int = 10,
    val mixes: List<Mix> = emptyList(),
)

enum class PiState { OFF, CHECKING, ONLINE, OFFLINE }

/** App-wide "is my Pi reachable?" state, shown in the player and settings. */
object TasteAiStatus {
    private val _state = MutableStateFlow(PiState.OFF)
    val state: StateFlow<PiState> = _state.asStateFlow()

    fun set(value: PiState) {
        _state.value = value
    }
}

internal object MusicAiHttp {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    val client by lazy {
        HttpClient(OkHttp) {
            install(ContentNegotiation) { json(json) }
            install(HttpTimeout) {
                connectTimeoutMillis = 4_000
                requestTimeoutMillis = 10_000
            }
            expectSuccess = false
        }
    }

    fun base(url: String) = url.trim().trimEnd('/')

    val serverUrl: String get() = base(Settings.shared.tasteAiUrl)

    val tasteAiActive: Boolean get() = Settings.shared.tasteAiEnabled && serverUrl.isNotBlank()
}

fun SongItem.toTasteTrack() =
    TasteTrack(
        id = id,
        title = title,
        artists = artists.map { it.name },
        album = album?.name,
        duration = (duration ?: 0L).toInt(),
    )

fun thumbnailFor(id: String) = "https://i.ytimg.com/vi/$id/hqdefault.jpg"

class TasteAiManager(
    private val scope: CoroutineScope,
) {
    private val pending = ArrayDeque<TasteEvent>()
    private val pendingLock = Mutex()
    private val recentIds = ArrayDeque<String>()

    fun start(
        currentSong: StateFlow<SongItem?>,
        currentPosition: StateFlow<Long>,
        isSameQueue: (previous: SongItem) -> Boolean,
    ) {
        scope.launch {
            while (isActive) {
                TasteAiStatus.set(
                    when {
                        !MusicAiHttp.tasteAiActive -> PiState.OFF
                        health(MusicAiHttp.serverUrl)?.ok == true -> PiState.ONLINE
                        else -> PiState.OFFLINE
                    },
                )
                delay(STATUS_INTERVAL_MS)
            }
        }
        // The highest position reached is how far the previous song was listened to.
        scope.launch {
            var previous: SongItem? = null
            var maxPosition = 0L
            combine(currentSong, currentPosition) { song, position -> song to position }.collect { (song, position) ->
                if (song?.id != previous?.id) {
                    previous?.let { onSongFinished(it, maxPosition, isSameQueue(it)) }
                    previous = song
                    maxPosition = 0L
                    song?.id?.let {
                        recentIds.addLast(it)
                        while (recentIds.size > 50) recentIds.removeFirst()
                    }
                } else if (position > maxPosition) {
                    maxPosition = position
                }
            }
        }
    }

    private fun onSongFinished(
        song: SongItem,
        listenedMs: Long,
        sameQueue: Boolean,
    ) {
        if (!MusicAiHttp.tasteAiActive || song.isPodcast) return
        val durationMs = (song.duration ?: 0L) * 1000L
        val type =
            when {
                durationMs > 0 && listenedMs >= durationMs * 0.8 -> "complete"
                // A new queue replacing this one says nothing about the song.
                sameQueue -> "skip"
                else -> null
            } ?: return
        queue(TasteEvent(type, song.toTasteTrack(), System.currentTimeMillis(), listenedMs))
    }

    fun onLikeChanged(
        song: SongItem,
        liked: Boolean,
    ) {
        if (!MusicAiHttp.tasteAiActive) return
        queue(TasteEvent(if (liked) "like" else "unlike", song.toTasteTrack(), System.currentTimeMillis()))
    }

    private fun queue(event: TasteEvent) {
        scope.launch(Dispatchers.IO) {
            pendingLock.withLock {
                pending.addLast(event)
                while (pending.size > MAX_PENDING) pending.removeFirst()
            }
            flush()
        }
    }

    private suspend fun flush() {
        val url = MusicAiHttp.serverUrl
        if (url.isBlank()) return
        val batch = pendingLock.withLock { pending.toList() }
        if (batch.isEmpty()) return
        runCatching {
            val res =
                MusicAiHttp.client.post("$url/events") {
                    contentType(ContentType.Application.Json)
                    setBody(EventsRequest(batch))
                }
            if (res.status.isSuccess()) {
                pendingLock.withLock { repeat(batch.size.coerceAtMost(pending.size)) { pending.removeFirst() } }
                TasteAiStatus.set(PiState.ONLINE)
            }
        }.onFailure {
            TasteAiStatus.set(PiState.OFFLINE)
            Timber.tag(TAG).d("Pi not reachable, keeping ${batch.size} events for later")
        }
    }

    /** Puts the songs the Pi likes most first; returns the input unchanged when Taste AI is off or offline. */
    suspend fun rank(candidates: List<SongItem>): List<SongItem> {
        if (!MusicAiHttp.tasteAiActive || candidates.size < 2) return candidates
        val url = MusicAiHttp.serverUrl
        val recent = recentIds.toList().takeLast(20)
        val ranked =
            withContext(Dispatchers.IO) {
                flush()
                runCatching {
                    val res =
                        MusicAiHttp.client.post("$url/rank") {
                            contentType(ContentType.Application.Json)
                            setBody(RankRequest(candidates.map { it.toTasteTrack() }, recent, RANK_COUNT))
                            timeout { requestTimeoutMillis = 8_000 }
                        }
                    if (res.status.isSuccess()) res.body<RankResponse>().ids else null
                }.getOrNull()
            }
        if (ranked.isNullOrEmpty()) return candidates
        val byId = candidates.associateBy { it.id }
        val first = ranked.mapNotNull { byId[it] }.distinctBy { it.id }
        val firstIds = first.mapTo(hashSetOf()) { it.id }
        return first + candidates.filterNot { it.id in firstIds }
    }

    companion object {
        private const val TAG = "TasteAi"
        private const val MAX_PENDING = 1000
        private const val RANK_COUNT = 10
        private const val STATUS_INTERVAL_MS = 60_000L

        /** Asks the Pi to retrain now, then returns the AI mixes. */
        suspend fun mixes(url: String): MixesResponse? =
            withContext(Dispatchers.IO) {
                val base = MusicAiHttp.base(url)
                runCatching {
                    MusicAiHttp.client.post("$base/train") { timeout { requestTimeoutMillis = 60_000 } }
                    val res = MusicAiHttp.client.get("$base/mixes")
                    if (res.status.isSuccess()) res.body<MixesResponse>() else null
                }.getOrNull()
            }

        suspend fun health(url: String): HealthResponse? =
            withContext(Dispatchers.IO) {
                runCatching {
                    val res = MusicAiHttp.client.get("${MusicAiHttp.base(url)}/health")
                    if (res.status.isSuccess()) res.body<HealthResponse>() else null
                }.getOrNull()
            }
    }
}
