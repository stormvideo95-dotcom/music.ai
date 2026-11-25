/**
 * Music AI (fork of Metrolist) — wiring between the playback service and the Pi features
 * Licensed under GPL-3.0
 */

package com.metrolist.android.tasteai

import com.metrolist.android.playback.MusicService
import com.metrolist.shared.db.MusicDatabase
import com.metrolist.shared.model.SongItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object MusicAi {
    private val _deviceSync = MutableStateFlow<DeviceSync?>(null)
    val deviceSync: StateFlow<DeviceSync?> = _deviceSync.asStateFlow()

    private var tasteAi: TasteAiManager? = null

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
        tasteAi = taste
        _deviceSync.value = sync
    }

    fun detach() {
        tasteAi = null
        _deviceSync.value = null
    }

    /** Reorders the songs picked to continue the queue by Storm's taste. */
    suspend fun rankRecommendations(songs: List<SongItem>): List<SongItem> = tasteAi?.rank(songs) ?: songs
}
