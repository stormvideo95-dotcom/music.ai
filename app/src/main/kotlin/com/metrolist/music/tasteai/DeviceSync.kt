/**
 * Music AI (fork of Metrolist) — device sync through the Pi
 * Licensed under GPL-3.0
 *
 * - Pairing with a one-time code (the first device is trusted automatically)
 * - Tells the Pi what this phone is playing (for "Continue here" on the Mac)
 * - Listens for "play on this phone" commands from the Mac
 * - Sends "play on Mac" commands
 */

package com.metrolist.music.tasteai

import android.content.Context
import android.os.Build
import androidx.datastore.preferences.core.edit
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.metrolist.music.constants.TasteAiDeviceTokenKey
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
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import timber.log.Timber

@Serializable
data class SyncTrack(
    val id: String,
    val title: String = "",
    val artists: List<String> = emptyList(),
    val album: String? = null,
    val duration: Int = 0,
    val thumbnail: String? = null,
)

@Serializable
data class SyncState(
    val track: SyncTrack? = null,
    val positionMs: Long = 0,
    val playing: Boolean = false,
    val queue: List<SyncTrack> = emptyList(),
    val updatedAt: Long = 0,
)

@Serializable
data class SyncDevice(
    val id: String,
    val name: String = "",
    val type: String = "other",
    val me: Boolean = false,
    val online: Boolean = false,
    val state: SyncState = SyncState(),
)

@Serializable
private data class DevicesResponse(val me: String = "", val devices: List<SyncDevice> = emptyList())

@Serializable
data class SyncCommand(
    val action: String = "",
    val track: SyncTrack? = null,
    val positionMs: Long = 0,
    val queue: List<SyncTrack> = emptyList(),
    val from: String? = null,
)

@Serializable
private data class CommandsResponse(val commands: List<SyncCommand> = emptyList())

@Serializable
private data class PairStartRequest(val name: String, val type: String)

@Serializable
data class PairStartResponse(
    val approved: Boolean = false,
    val token: String? = null,
    val code: String? = null,
    val pairId: String? = null,
    val expired: Boolean = false,
)

@Serializable
private data class ApproveRequest(val code: String)

@Serializable
private data class StateRequest(val state: SyncState)

@Serializable
private data class CommandRequest(val target: String, val command: SyncCommand)

fun MediaMetadata.toSyncTrack() =
    SyncTrack(
        id = id,
        title = title,
        artists = artists.map { it.name },
        album = album?.title,
        duration = duration,
        thumbnail = thumbnailUrl,
    )

fun SyncTrack.toMediaItem(): MediaItem =
    MediaMetadata(
        id = id,
        title = title,
        artists = artists.map { MediaMetadata.Artist(id = null, name = it) },
        duration = duration,
        thumbnailUrl = thumbnail ?: "https://i.ytimg.com/vi/$id/hqdefault.jpg",
    ).toMediaItem()

enum class PairResult { PAIRED, WRONG_CODE, OFFLINE }

class DeviceSync(
    private val context: Context,
    private val scope: CoroutineScope,
    private val player: () -> Player,
    private val playItems: (title: String, items: List<MediaItem>, positionMs: Long) -> Unit,
) {
    @Volatile private var url = ""
    @Volatile private var enabled = false
    @Volatile private var token = ""

    private val _devices = MutableStateFlow<List<SyncDevice>>(emptyList())
    val devices: StateFlow<List<SyncDevice>> = _devices.asStateFlow()

    private val _paired = MutableStateFlow(false)
    val paired: StateFlow<Boolean> = _paired.asStateFlow()

    /** Last "playing on X" message, shown briefly in the device sheet. */
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val active get() = enabled && url.isNotBlank() && token.isNotBlank()

    fun start() {
        scope.launch {
            context.dataStore.data
                .map { Triple(it[TasteAiEnabledKey] ?: false, (it[TasteAiUrlKey] ?: "").trim().trimEnd('/'), it[TasteAiDeviceTokenKey] ?: "") }
                .distinctUntilChanged()
                .collect { (e, u, t) ->
                    enabled = e
                    url = u
                    token = t
                    _paired.value = t.isNotBlank()
                }
        }
        // Heartbeat: tell the Pi what is playing here.
        scope.launch {
            while (isActive) {
                val playing = runCatching { player().isPlaying }.getOrDefault(false)
                if (active) sendState()
                delay(if (playing) 10_000 else 30_000)
            }
        }
        // Wait for commands from other devices (long-poll).
        scope.launch(Dispatchers.IO) {
            while (isActive) {
                if (!active) {
                    delay(5_000)
                    continue
                }
                val commands =
                    runCatching {
                        val res =
                            client.get("$url/sync/commands?wait=20") {
                                header("X-Device-Token", token)
                                timeout { requestTimeoutMillis = 30_000 }
                            }
                        if (res.status == HttpStatusCode.Unauthorized) forgetToken()
                        if (res.status.isSuccess()) res.body<CommandsResponse>().commands else null
                    }.getOrNull()
                if (commands == null) {
                    delay(10_000)
                    continue
                }
                commands.forEach { handle(it) }
            }
        }
    }

    private suspend fun forgetToken() {
        context.dataStore.edit { it.remove(TasteAiDeviceTokenKey) }
    }

    private suspend fun handle(command: SyncCommand) =
        withContext(Dispatchers.Main) {
            when (command.action) {
                "play" -> {
                    val tracks = listOfNotNull(command.track) + command.queue
                    if (tracks.isEmpty()) return@withContext
                    playItems(command.from?.let { "From $it" } ?: "Music AI", tracks.map { it.toMediaItem() }, command.positionMs)
                    _message.value = command.from?.let { "Moved here from $it" }
                }
                "pause" -> player().pause()
            }
        }

    private suspend fun currentState(): SyncState =
        withContext(Dispatchers.Main) {
            val p = player()
            val current = p.currentMediaItem?.metadata
            val next =
                (p.currentMediaItemIndex + 1 until minOf(p.mediaItemCount, p.currentMediaItemIndex + 26))
                    .mapNotNull { p.getMediaItemAt(it).metadata?.toSyncTrack() }
            SyncState(
                track = current?.toSyncTrack(),
                positionMs = p.currentPosition.coerceAtLeast(0),
                playing = p.isPlaying,
                queue = next,
                updatedAt = System.currentTimeMillis(),
            )
        }

    suspend fun sendState() {
        if (!active) return
        val state = currentState()
        withContext(Dispatchers.IO) {
            runCatching {
                client.post("$url/sync/state") {
                    header("X-Device-Token", token)
                    contentType(ContentType.Application.Json)
                    setBody(StateRequest(state))
                }
            }
        }
    }

    /** Refresh the device list for the "Play on" sheet. */
    suspend fun refreshDevices() {
        if (!active) {
            _devices.value = emptyList()
            return
        }
        withContext(Dispatchers.IO) {
            runCatching {
                val res = client.get("$url/sync/devices") { header("X-Device-Token", token) }
                if (res.status == HttpStatusCode.Unauthorized) forgetToken()
                if (res.status.isSuccess()) _devices.value = res.body<DevicesResponse>().devices
            }.onFailure { Timber.tag(TAG).d("devices: Pi offline") }
        }
    }

    /** Move playback to another device and pause here. */
    suspend fun playOn(device: SyncDevice): Boolean {
        val state = currentState()
        val track = state.track ?: return false
        val ok =
            withContext(Dispatchers.IO) {
                runCatching {
                    client
                        .post("$url/sync/command") {
                            header("X-Device-Token", token)
                            contentType(ContentType.Application.Json)
                            setBody(CommandRequest(device.id, SyncCommand("play", track, state.positionMs, state.queue)))
                        }.status
                        .isSuccess()
                }.getOrDefault(false)
            }
        if (ok) withContext(Dispatchers.Main) { player().pause() }
        return ok
    }

    /** Pick up where another device is (or was). */
    fun continueFrom(device: SyncDevice) {
        val s = device.state
        val tracks = listOfNotNull(s.track) + s.queue
        if (tracks.isEmpty()) return
        val elapsed = if (s.playing && s.updatedAt > 0) System.currentTimeMillis() - s.updatedAt else 0
        playItems("From ${device.name}", tracks.map { it.toMediaItem() }, s.positionMs + elapsed)
        if (s.playing) {
            scope.launch(Dispatchers.IO) {
                runCatching {
                    client.post("$url/sync/command") {
                        header("X-Device-Token", token)
                        contentType(ContentType.Application.Json)
                        setBody(CommandRequest(device.id, SyncCommand("pause")))
                    }
                }
            }
        }
    }

    // ---------- Pairing ----------

    /** Start pairing this phone. Returns a code to type on a paired device, or null when already paired/offline. */
    suspend fun pairStart(serverUrl: String): PairStartResponse? {
        val base = serverUrl.trim().trimEnd('/')
        val name = Build.MODEL ?: "Phone"
        val res =
            withContext(Dispatchers.IO) {
                runCatching {
                    val r =
                        client.post("$base/pair/start") {
                            contentType(ContentType.Application.Json)
                            setBody(PairStartRequest(name, "phone"))
                        }
                    if (r.status.isSuccess()) r.body<PairStartResponse>() else null
                }.getOrNull()
            } ?: return null
        if (res.approved && res.token != null) saveToken(res.token)
        return res
    }

    /** Poll until a paired device approves our code. */
    suspend fun pairWait(
        serverUrl: String,
        pairId: String,
    ): Boolean {
        val base = serverUrl.trim().trimEnd('/')
        repeat(200) {
            val res =
                withContext(Dispatchers.IO) {
                    runCatching { client.get("$base/pair/status?pairId=$pairId").body<PairStartResponse>() }.getOrNull()
                }
            if (res?.approved == true && res.token != null) {
                saveToken(res.token)
                return true
            }
            if (res?.expired == true) return false
            delay(3_000)
        }
        return false
    }

    /** Approve a new device (e.g. the Mac) by typing the code it shows. */
    suspend fun approve(code: String): PairResult =
        withContext(Dispatchers.IO) {
            runCatching {
                val r =
                    client.post("$url/pair/approve") {
                        header("X-Device-Token", token)
                        contentType(ContentType.Application.Json)
                        setBody(ApproveRequest(code.trim()))
                    }
                if (r.status.isSuccess()) PairResult.PAIRED else PairResult.WRONG_CODE
            }.getOrDefault(PairResult.OFFLINE)
        }

    suspend fun unpair() {
        withContext(Dispatchers.IO) {
            runCatching {
                client.post("$url/sync/unpair") {
                    header("X-Device-Token", token)
                    contentType(ContentType.Application.Json)
                    setBody(mapOf<String, String>())
                }
            }
        }
        forgetToken()
    }

    private suspend fun saveToken(value: String) {
        context.dataStore.edit { it[TasteAiDeviceTokenKey] = value }
        token = value
        _paired.value = true
    }

    fun clearMessage() {
        _message.value = null
    }

    companion object {
        private const val TAG = "DeviceSync"
        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        private val client by lazy {
            HttpClient(OkHttp) {
                install(ContentNegotiation) { json(json) }
                install(HttpTimeout) {
                    connectTimeoutMillis = 4_000
                    requestTimeoutMillis = 10_000
                }
                expectSuccess = false
            }
        }
    }
}
