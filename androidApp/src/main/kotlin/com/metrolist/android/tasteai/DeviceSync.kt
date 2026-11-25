/**
 * Music AI (fork of Metrolist) — device sync through the Pi
 * Licensed under GPL-3.0
 *
 * - Pairing with a one-time code (the first device is trusted automatically)
 * - Tells the Pi what this phone is playing (for "Continue here" on the Mac)
 * - Listens for "play on this phone" commands from the Mac
 * - Sends "play on Mac" commands
 */

package com.metrolist.android.tasteai

import android.os.Build
import com.metrolist.shared.generated.resources.Res
import com.metrolist.shared.generated.resources.musicai_from_device
import com.metrolist.shared.generated.resources.musicai_settings_group
import com.metrolist.shared.model.ArtistTiny
import com.metrolist.shared.model.SongItem
import com.metrolist.shared.settings.Settings
import io.ktor.client.call.body
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import org.jetbrains.compose.resources.getString
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
private data class DevicesResponse(
    val me: String = "",
    val devices: List<SyncDevice> = emptyList(),
)

@Serializable
data class SyncCommand(
    val action: String = "",
    val track: SyncTrack? = null,
    val positionMs: Long = 0,
    val queue: List<SyncTrack> = emptyList(),
    val from: String? = null,
)

@Serializable
private data class CommandsResponse(
    val commands: List<SyncCommand> = emptyList(),
)

@Serializable
private data class PairStartRequest(
    val name: String,
    val type: String,
)

@Serializable
data class PairStartResponse(
    val approved: Boolean = false,
    val token: String? = null,
    val code: String? = null,
    val pairId: String? = null,
    val expired: Boolean = false,
)

@Serializable
private data class ApproveRequest(
    val code: String,
)

@Serializable
private data class StateRequest(
    val state: SyncState,
)

@Serializable
private data class CommandRequest(
    val target: String,
    val command: SyncCommand,
)

@Serializable
private class EmptyRequest

fun SongItem.toSyncTrack() =
    SyncTrack(
        id = id,
        title = title,
        artists = artists.map { it.name },
        album = album?.name,
        duration = (duration ?: 0L).toInt(),
        thumbnail = thumbnail,
    )

fun SyncTrack.toSongItem() =
    SongItem(
        id = id,
        title = title,
        thumbnail = thumbnail ?: thumbnailFor(id),
        artists = artists.map { ArtistTiny(id = null, name = it) },
        album = null,
        duration = duration.toLong().takeIf { it > 0 },
    )

enum class PairResult { PAIRED, WRONG_CODE, OFFLINE }

/** What the phone's player is doing right now, read on the main thread. */
interface DeviceSyncPlayer {
    val isPlaying: Boolean

    fun state(): SyncState

    fun play(
        title: String,
        songs: List<SongItem>,
        positionMs: Long,
    )

    fun pause()
}

class DeviceSync(
    private val scope: CoroutineScope,
    private val player: DeviceSyncPlayer,
) {
    private val _devices = MutableStateFlow<List<SyncDevice>>(emptyList())
    val devices: StateFlow<List<SyncDevice>> = _devices.asStateFlow()

    /** Last "playing on X" message, shown briefly in the device sheet. */
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val url get() = MusicAiHttp.serverUrl
    private val token get() = Settings.shared.tasteAiDeviceToken

    val paired: Boolean get() = token.isNotBlank()

    private val active get() = Settings.shared.tasteAiEnabled && url.isNotBlank() && token.isNotBlank()

    fun start() {
        // Heartbeat: tell the Pi what is playing here.
        scope.launch {
            while (isActive) {
                if (active) sendState()
                delay(if (player.isPlaying) 10_000 else 30_000)
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
                            MusicAiHttp.client.get("$url/sync/commands?wait=20") {
                                header(TOKEN_HEADER, token)
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

    private suspend fun forgetToken() =
        withContext(Dispatchers.Main) {
            Settings.shared.tasteAiDeviceToken = ""
        }

    private suspend fun fromTitle(name: String?): String =
        if (name.isNullOrBlank()) getString(Res.string.musicai_settings_group) else getString(Res.string.musicai_from_device, name)

    private suspend fun handle(command: SyncCommand) {
        when (command.action) {
            "play" -> {
                val tracks = listOfNotNull(command.track) + command.queue
                if (tracks.isEmpty()) return
                val title = fromTitle(command.from)
                withContext(Dispatchers.Main) { player.play(title, tracks.map { it.toSongItem() }, command.positionMs) }
                _message.value = command.from
            }

            "pause" -> {
                withContext(Dispatchers.Main) { player.pause() }
            }
        }
    }

    suspend fun sendState() {
        if (!active) return
        val state = withContext(Dispatchers.Main) { player.state() }
        withContext(Dispatchers.IO) {
            runCatching {
                MusicAiHttp.client.post("$url/sync/state") {
                    header(TOKEN_HEADER, token)
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
                val res = MusicAiHttp.client.get("$url/sync/devices") { header(TOKEN_HEADER, token) }
                if (res.status == HttpStatusCode.Unauthorized) forgetToken()
                if (res.status.isSuccess()) _devices.value = res.body<DevicesResponse>().devices
            }.onFailure { Timber.tag(TAG).d("devices: Pi offline") }
        }
    }

    /** Move playback to another device and pause here. */
    suspend fun playOn(device: SyncDevice): Boolean {
        val state = withContext(Dispatchers.Main) { player.state() }
        val track = state.track ?: return false
        val ok =
            withContext(Dispatchers.IO) {
                runCatching {
                    MusicAiHttp.client
                        .post("$url/sync/command") {
                            header(TOKEN_HEADER, token)
                            contentType(ContentType.Application.Json)
                            setBody(CommandRequest(device.id, SyncCommand("play", track, state.positionMs, state.queue)))
                        }.status
                        .isSuccess()
                }.getOrDefault(false)
            }
        if (ok) withContext(Dispatchers.Main) { player.pause() }
        return ok
    }

    /** Pick up where another device is (or was). */
    fun continueFrom(device: SyncDevice) {
        val s = device.state
        val tracks = listOfNotNull(s.track) + s.queue
        if (tracks.isEmpty()) return
        val elapsed = if (s.playing && s.updatedAt > 0) System.currentTimeMillis() - s.updatedAt else 0
        scope.launch {
            val title = fromTitle(device.name)
            withContext(Dispatchers.Main) { player.play(title, tracks.map { it.toSongItem() }, s.positionMs + elapsed) }
            if (s.playing) {
                withContext(Dispatchers.IO) {
                    runCatching {
                        MusicAiHttp.client.post("$url/sync/command") {
                            header(TOKEN_HEADER, token)
                            contentType(ContentType.Application.Json)
                            setBody(CommandRequest(device.id, SyncCommand("pause")))
                        }
                    }
                }
            }
        }
    }

    // ---------- Pairing ----------

    /** Start pairing this phone. Returns a code to type on a paired device, or null when offline. */
    suspend fun pairStart(serverUrl: String): PairStartResponse? {
        val base = MusicAiHttp.base(serverUrl)
        val name = Build.MODEL ?: "Phone"
        val res =
            withContext(Dispatchers.IO) {
                runCatching {
                    val r =
                        MusicAiHttp.client.post("$base/pair/start") {
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
        val base = MusicAiHttp.base(serverUrl)
        repeat(200) {
            val res =
                withContext(Dispatchers.IO) {
                    runCatching { MusicAiHttp.client.get("$base/pair/status?pairId=$pairId").body<PairStartResponse>() }.getOrNull()
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
                    MusicAiHttp.client.post("$url/pair/approve") {
                        header(TOKEN_HEADER, token)
                        contentType(ContentType.Application.Json)
                        setBody(ApproveRequest(code.trim()))
                    }
                if (r.status.isSuccess()) PairResult.PAIRED else PairResult.WRONG_CODE
            }.getOrDefault(PairResult.OFFLINE)
        }

    suspend fun unpair() {
        withContext(Dispatchers.IO) {
            runCatching {
                MusicAiHttp.client.post("$url/sync/unpair") {
                    header(TOKEN_HEADER, token)
                    contentType(ContentType.Application.Json)
                    setBody(EmptyRequest())
                }
            }
        }
        forgetToken()
    }

    private suspend fun saveToken(value: String) =
        withContext(Dispatchers.Main) {
            Settings.shared.tasteAiDeviceToken = value
        }

    fun clearMessage() {
        _message.value = null
    }

    companion object {
        private const val TAG = "DeviceSync"
        private const val TOKEN_HEADER = "X-Device-Token"
    }
}
