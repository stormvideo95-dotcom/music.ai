/**
 * Music AI (fork of Metrolist) — AI mixes
 * Licensed under GPL-3.0
 *
 * Turns the taste groups the Pi found (phonk, chill, ...) into 2-4 playlists.
 * They live only in this app (not synced to YouTube Music) and use fixed ids,
 * so a refresh updates the same playlists instead of making new ones.
 */

package com.metrolist.music.tasteai

import android.content.Context
import com.metrolist.music.R
import com.metrolist.music.db.MusicDatabase
import com.metrolist.music.db.entities.PlaylistEntity
import com.metrolist.music.models.MediaMetadata
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.withContext
import java.time.LocalDateTime

object AiMixes {
    private const val MAX_MIXES = 4

    private fun playlistId(index: Int) = "LP_AIMIX_${index + 1}"

    /** Returns the Pi's answer, or null if the Pi couldn't be reached. */
    suspend fun refresh(
        context: Context,
        database: MusicDatabase,
        url: String,
    ): MixesResponse? {
        val response = TasteAiManager.mixes(url)
        TasteAiStatus.set(if (response != null) PiState.ONLINE else PiState.OFFLINE)
        if (response == null || !response.ready) return response

        withContext(Dispatchers.IO) {
            for (index in 0 until MAX_MIXES) {
                val id = playlistId(index)
                val mix = response.mixes.getOrNull(index)
                val existing = database.playlist(id).firstOrNull()

                if (mix == null) {
                    if (existing != null) {
                        database.clearPlaylist(id)
                        database.delete(existing.playlist)
                    }
                    continue
                }

                val name = context.getString(R.string.taste_ai_mix_prefix, mix.name)
                if (existing == null) {
                    database.insert(PlaylistEntity(id = id, name = name))
                } else {
                    database.update(existing.playlist.copy(name = name, lastUpdateTime = LocalDateTime.now()))
                }
                database.clearPlaylist(id)

                mix.songs.forEach { song ->
                    if (database.getSongByIdBlocking(song.id) == null) {
                        database.insert(
                            MediaMetadata(
                                id = song.id,
                                title = song.title,
                                artists = song.artists.map { MediaMetadata.Artist(id = null, name = it) },
                                duration = song.duration,
                                thumbnailUrl = "https://i.ytimg.com/vi/${song.id}/hqdefault.jpg",
                            ),
                        )
                    }
                }
                val playlist = database.playlist(id).firstOrNull() ?: continue
                database.addSongsToPlaylist(playlist, mix.songs.map { it.id to null })
            }
        }
        return response
    }
}
