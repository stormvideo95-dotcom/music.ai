/**
 * Music AI (fork of Metrolist) — wiring between the playback service and the Pi features
 * Licensed under GPL-3.0
 */

package com.metrolist.android.tasteai

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.metrolist.android.playback.MusicService
import com.metrolist.shared.db.MusicDatabase
import com.metrolist.shared.model.SongItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object MusicAi {
    private val _deviceSync = MutableStateFlow<DeviceSync?>(null)
    val deviceSync: StateFlow<DeviceSync?> = _deviceSync.asStateFlow()

    private var tasteAi: TasteAiManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    fun attach(
        service: MusicService,
        scope: CoroutineScope,
        database: MusicDatabase,
    ) {
        val player = service.player
        val taste = TasteAiManager(scope)
        taste.start(
            currentSong = player.currentSong,
            currentPosition = player.currentPosition,
            isSameQueue = { previous -> player.songQueue.value.any { it.id == previous.id } },
        )
        LikesSync(service, scope, database, taste) { player.currentSong.value?.id }.start()
        val sync =
            DeviceSync(
                scope,
                object : DeviceSyncPlayer {
                    override val isPlaying: Boolean get() = player.isPlaying.value

                    override fun state(): SyncState {
                        val queue = player.songQueue.value
                        val index = player.currentMediaItemIndex.value
                        return SyncState(
                            track = player.currentSong.value?.toSyncTrack(),
                            positionMs = player.currentPosition.value.coerceAtLeast(0),
                            playing = player.isPlaying.value,
                            queue = queue.drop(index + 1).take(25).map { it.toSyncTrack() },
                            updatedAt = System.currentTimeMillis(),
                        )
                    }

                    override fun play(
                        title: String,
                        songs: List<SongItem>,
                        positionMs: Long,
                    ) = service.playQueue(songs, startIndex = 0, queueTitle = title, finite = true, startPositionMs = positionMs)

                    override fun pause() = player.pause()
                },
            )
        sync.start()
        watchNetwork(service, scope)
        tasteAi = taste
        _deviceSync.value = sync
    }

    // Wi-Fi <-> mobile data: the home address may have stopped (or started) working.
    private fun watchNetwork(
        context: Context,
        scope: CoroutineScope,
    ) {
        val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return
        var pending: Job? = null
        val callback =
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = recheck()

                override fun onLost(network: Network) = recheck()

                private fun recheck() {
                    pending?.cancel()
                    pending =
                        scope.launch {
                            delay(3_000)
                            if (MusicAiHttp.tasteAiActive) {
                                TasteAiStatus.set(if (PiAddress.resolve() != null) PiState.ONLINE else PiState.OFFLINE)
                            }
                        }
                }
            }
        runCatching { connectivity.registerDefaultNetworkCallback(callback) }.onSuccess { networkCallback = callback }
    }

    fun detach(context: Context) {
        networkCallback?.let { callback ->
            runCatching { context.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback) }
        }
        networkCallback = null
        tasteAi = null
        _deviceSync.value = null
    }

    /** Reorders the songs picked to continue the queue by Storm's taste. */
    suspend fun rankRecommendations(songs: List<SongItem>): List<SongItem> = tasteAi?.rank(songs) ?: songs
}
