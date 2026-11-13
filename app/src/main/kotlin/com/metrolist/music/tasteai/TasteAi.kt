/**
 * Music AI (fork of Metrolist) — Taste AI
 * Licensed under GPL-3.0
 *
 * Talks to Storm's own taste server (Umbrel / Raspberry Pi 5).
 * - Sends listening events (complete / skip / like / unlike)
 * - When the queue is about to run out, it asks YouTube for candidate songs,
 *   lets the Pi rank them by taste, and appends the best ones.
 * If the Pi can't be reached, it falls back to YouTube's own order.
 */

package com.metrolist.music.tasteai

import android.content.Context
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.metrolist.innertube.YouTube
import com.metrolist.innertube.models.WatchEndpoint
import com.metrolist.music.constants.TasteAiEnabledKey
import com.metrolist.music.constants.TasteAiUrlKey
import com.metrolist.music.extensions.metadata
import com.metrolist.music.extensions.toMediaItem
import com.metrolist.music.models.MediaMetadata
import com.metrolist.music.utils.dataStore
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
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.map
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
private data class EventsRequest(val events: List<TasteEvent>)

@Serializable
private data class RankRequest(
    val candidates: List<TasteTrack>,
    val recent: List<String>,
    val count: Int,
)

@Serializable
data class RankResponse(val ids: List<String> = emptyList())

@Serializable
data class HealthResponse(val ok: Boolean = false, val events: Int = 0, val trained: Boolean = false)

@Serializable
data class MixSong(
    val id: String,
    val title: String = "",
    val artists: List<String> = emptyList(),
    val album: String? = null,
    val duration: Int = 0,
)

@Serializable
data class Mix(val name: String, val songs: List<MixSong> = emptyList())

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

fun MediaMetadata.toTasteTrack() =
    TasteTrack(
        id = id,
        title = title,
        artists = artists.map { it.name },
        album = album?.title,
        duration = duration,
    )

class TasteAiManager(
    private val context: Context,
    private val scope: CoroutineScope,
) {
    @Volatile var enabled = false
        private set

    @Volatile var serverUrl = ""
        private set

    private val pending = ArrayDeque<TasteEvent>()
    private val pendingLock = Mutex()
    private val recentIds = ArrayDeque<String>()

    private var currentTrack: MediaMetadata? = null
    private var currentStartedAt = 0L

    private var lastLikeId: String? = null
    private var lastLiked: Boolean? = null

    @Volatile private var extending = false

    fun start() {
        scope.launch {
            context.dataStore.data
                .map { it[TasteAiEnabledKey] ?: false }
                .distinctUntilChanged()
                .collect { enabled = it }
        }
        scope.launch {
            context.dataStore.data
                .map { (it[TasteAiUrlKey] ?: "").trim().trimEnd('/') }
                .distinctUntilChanged()
                .collect { serverUrl = it }
        }
        scope.launch {
            while (isActive) {
                if (active) {
                    TasteAiStatus.set(if (health(serverUrl)?.ok == true) PiState.ONLINE else PiState.OFFLINE)
                } else {
                    TasteAiStatus.set(PiState.OFF)
                }
                delay(STATUS_INTERVAL_MS)
            }
        }
    }

    private val active get() = enabled && serverUrl.isNotBlank()

    /** Call from Player.Listener.onMediaItemTransition. */
    fun onTrackChanged(
        newTrack: MediaMetadata?,
        reason: Int,
    ) {
        val previous = currentTrack
        val now = System.currentTimeMillis()
        if (active && previous != null && !previous.isEpisode && previous.id != newTrack?.id) {
            val listened = now - currentStartedAt
            val durationMs = previous.duration * 1000L
            val type =
                when (reason) {
                    Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "complete"
                    Player.MEDIA_ITEM_TRANSITION_REASON_SEEK ->
                        // Skipped early = didn't like it. Skipped late = basically finished.
                        if (durationMs > 0 && listened >= durationMs * 0.8) "complete" else "skip"
                    else -> null
                }
            if (type != null) queue(TasteEvent(type, previous.toTasteTrack(), now, listened))
        }
        currentTrack = newTrack
        currentStartedAt = now
        newTrack?.id?.let {
            recentIds.addLast(it)
            while (recentIds.size > 50) recentIds.removeFirst()
        }
    }

    /** Call whenever the current song's liked state is observed. */
    fun onLikeState(
        track: MediaMetadata?,
        liked: Boolean?,
    ) {
        if (track == null || liked == null) return
        if (track.id == lastLikeId && lastLiked != null && lastLiked != liked && active) {
            queue(TasteEvent(if (liked) "like" else "unlike", track.toTasteTrack(), System.currentTimeMillis()))
        }
        lastLikeId = track.id
        lastLiked = liked
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
        val url = serverUrl
        if (url.isBlank()) return
        val batch = pendingLock.withLock { pending.toList() }
        if (batch.isEmpty()) return
        runCatching {
            val res =
                client.post("$url/events") {
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

    /**
     * Call (on the main thread) after a transition. When the playlist is about to end,
     * fill it up with songs picked by the taste model.
     */
    fun maybeExtendQueue(
        player: Player,
        queueHasMorePages: Boolean,
        hideExplicit: Boolean,
    ) {
        if (!active || extending || queueHasMorePages) return
        if (player.repeatMode != Player.REPEAT_MODE_OFF) return
        val index = player.currentMediaItemIndex
        if (index == C.INDEX_UNSET) return
        if (player.mediaItemCount - index > SONGS_LEFT_TRIGGER) return
        val seed = player.currentMediaItem?.metadata ?: return

        val inQueue = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }.toSet()
        val recent = recentIds.toList()
        extending = true
        scope.launch {
            try {
                val picked =
                    withContext(Dispatchers.IO) {
                        val candidates =
                            fetchCandidates(seed)
                                .filter { it.mediaId !in inQueue && it.mediaId !in recent }
                                .filter { !hideExplicit || it.metadata?.explicit != true }
                                .distinctBy { it.mediaId }
                        if (candidates.isEmpty()) return@withContext emptyList()
                        val ranked = rank(candidates.mapNotNull { it.metadata?.toTasteTrack() }, recent)
                        val byId = candidates.associateBy { it.mediaId }
                        // Fallback: YouTube's own order if the Pi is offline.
                        (ranked?.mapNotNull { byId[it] } ?: candidates).take(ADD_COUNT)
                    }
                if (picked.isNotEmpty() && player.playbackState != Player.STATE_IDLE) {
                    player.addMediaItems(picked)
                }
            } catch (e: Exception) {
                Timber.tag(TAG).w(e, "Taste AI could not extend queue")
            } finally {
                extending = false
            }
        }
    }

    private suspend fun fetchCandidates(seed: MediaMetadata): List<MediaItem> {
        val radio =
            YouTube.next(WatchEndpoint(videoId = seed.id)).getOrNull()
        val items = radio?.items?.map { it.toMediaItem() }.orEmpty().toMutableList()
        if (items.size < 20) {
            radio?.relatedEndpoint?.let { endpoint ->
                YouTube.related(endpoint).getOrNull()?.songs?.forEach { items.add(it.toMediaItem()) }
            }
        }
        return items.filter { it.mediaId != seed.id }
    }

    private suspend fun rank(
        candidates: List<TasteTrack>,
        recent: List<String>,
    ): List<String>? {
        val url = serverUrl
        if (url.isBlank() || candidates.isEmpty()) return null
        flush()
        return runCatching {
            val res =
                client.post("$url/rank") {
                    contentType(ContentType.Application.Json)
                    setBody(RankRequest(candidates, recent.takeLast(20), ADD_COUNT))
                }
            if (res.status.isSuccess()) res.body<RankResponse>().ids.takeIf { it.isNotEmpty() } else null
        }.getOrNull()
    }

    companion object {
        private const val TAG = "TasteAi"
        private const val MAX_PENDING = 1000
        private const val SONGS_LEFT_TRIGGER = 2
        private const val ADD_COUNT = 10
        private const val STATUS_INTERVAL_MS = 60_000L

        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        private val client by lazy {
            HttpClient(OkHttp) {
                install(ContentNegotiation) { json(json) }
                install(HttpTimeout) {
                    connectTimeoutMillis = 4_000
                    requestTimeoutMillis = 8_000
                }
                expectSuccess = false
            }
        }

        /** Asks the Pi to retrain now, then returns the AI mixes. */
        suspend fun mixes(url: String): MixesResponse? =
            withContext(Dispatchers.IO) {
                val base = url.trim().trimEnd('/')
                runCatching {
                    client.post("$base/train") { timeout { requestTimeoutMillis = 60_000 } }
                    val res = client.get("$base/mixes")
                    if (res.status.isSuccess()) res.body<MixesResponse>() else null
                }.getOrNull()
            }

        /** Used by the settings screen "Test connection" button. */
        suspend fun health(url: String): HealthResponse? =
            withContext(Dispatchers.IO) {
                runCatching {
                    val res = client.get("${url.trim().trimEnd('/')}/health")
                    if (res.status.isSuccess()) res.body<HealthResponse>() else null
                }.getOrNull()
            }
    }
}
