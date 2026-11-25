/**
 * Music AI (fork of Metrolist) — AI mixes
 * Licensed under GPL-3.0
 *
 * Turns the taste groups the Pi found (phonk, chill, ...) into 2-4 playlists.
 * They live only in this app (not synced to YouTube Music) and use fixed ids,
 * so a refresh updates the same playlists instead of making new ones.
 */

package com.metrolist.android.tasteai

import com.metrolist.shared.db.MusicDatabase
import com.metrolist.shared.db.entities.PlaylistEntity
import com.metrolist.shared.db.withDatabaseTransaction
import com.metrolist.shared.generated.resources.Res
import com.metrolist.shared.generated.resources.musicai_mix_prefix
import com.metrolist.shared.model.ArtistTiny
import com.metrolist.shared.model.SongItem
import com.metrolist.shared.playlist.PlaylistChanges
import com.metrolist.shared.playlist.addSongsToLocalPlaylist
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import org.jetbrains.compose.resources.getString
import kotlin.time.Clock

object AiMixes {
    private const val MAX_MIXES = 4

    private fun playlistId(index: Int) = "LP_AIMIX_${index + 1}"

    /** Returns the Pi's answer, or null if the Pi couldn't be reached. */
    suspend fun refresh(
        database: MusicDatabase,
        url: String,
    ): MixesResponse? {
        val response = TasteAiManager.mixes(url)
        TasteAiStatus.set(if (response != null) PiState.ONLINE else PiState.OFFLINE)
        if (response == null || !response.ready) return response

        withContext(Dispatchers.IO) {
            val dao = database.dao()
            for (index in 0 until MAX_MIXES) {
                val id = playlistId(index)
                val mix = response.mixes.getOrNull(index)
                val existing = dao.findPlaylistEntity(id)

                if (mix == null) {
                    if (existing != null) {
                        database.withDatabaseTransaction {
                            dao.clearPlaylist(id)
                            dao.delete(existing)
                        }
                        PlaylistChanges.notifyChanged(id)
                    }
                    continue
                }

                val name = getString(Res.string.musicai_mix_prefix, mix.name)
                val now = Clock.System.now().toLocalDateTime(TimeZone.UTC)
                database.withDatabaseTransaction {
                    if (existing == null) {
                        // bookmarkedAt is what makes a playlist show up on the Library > Playlists page
                        dao.insert(PlaylistEntity(id = id, name = name, isLocal = true, bookmarkedAt = now, remoteSongCount = 0))
                    } else {
                        dao.update(
                            existing.copy(
                                name = name,
                                isLocal = true,
                                isEditable = true,
                                lastUpdateTime = now,
                                bookmarkedAt = existing.bookmarkedAt ?: now,
                                remoteSongCount = 0,
                            ),
                        )
                    }
                    dao.clearPlaylist(id)
                }

                val songs =
                    mix.songs.distinctBy { it.id }.map { song ->
                        SongItem(
                            id = song.id,
                            title = song.title,
                            thumbnail = thumbnailFor(song.id),
                            artists = song.artists.map { ArtistTiny(id = null, name = it) },
                            album = null,
                            duration = song.duration.toLong().takeIf { it > 0 },
                        )
                    }
                songs.chunked(100).forEach { addSongsToLocalPlaylist(database, id, it) }
                PlaylistChanges.notifyChanged(id)
            }
        }
        return response
    }
}
