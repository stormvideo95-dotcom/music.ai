/**
 * Music AI (fork of Metrolist) — "Play on" devices paired through the Pi
 * Licensed under GPL-3.0
 *
 * Shown at the top of Metrolist's device sheet (the cast button in the player).
 */

package com.metrolist.android.tasteai

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.metrolist.android.R
import com.metrolist.shared.generated.resources.Res
import com.metrolist.shared.generated.resources.musicai_play_on
import com.metrolist.shared.generated.resources.musicai_play_on_continue_here
import com.metrolist.shared.generated.resources.musicai_play_on_failed
import com.metrolist.shared.generated.resources.musicai_play_on_no_devices
import com.metrolist.shared.generated.resources.musicai_play_on_not_paired
import com.metrolist.shared.generated.resources.musicai_play_on_offline
import com.metrolist.shared.generated.resources.musicai_play_on_online
import com.metrolist.shared.generated.resources.musicai_play_on_paused
import com.metrolist.shared.generated.resources.musicai_play_on_playing
import com.metrolist.shared.settings.Settings
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource

@Composable
fun MusicAiDevicesSection(onDismiss: () -> Unit) {
    val sync = MusicAi.deviceSync.collectAsState().value ?: return
    if (!Settings.shared.tasteAiEnabled || Settings.shared.tasteAiUrl.isBlank()) return
    val devices by sync.devices.collectAsState()
    val paired = Settings.shared.tasteAiDeviceToken.isNotBlank()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val failedText = stringResource(Res.string.musicai_play_on_failed)

    LaunchedEffect(paired) {
        while (true) {
            sync.refreshDevices()
            delay(5_000)
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = stringResource(Res.string.musicai_play_on),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(start = 8.dp, bottom = 4.dp),
        )
        val others = devices.filter { !it.me }
        when {
            !paired -> Hint(stringResource(Res.string.musicai_play_on_not_paired))
            others.isEmpty() -> Hint(stringResource(Res.string.musicai_play_on_no_devices))
        }
        if (paired) {
            others.forEach { device ->
                val track = device.state.track
                val subtitle =
                    when {
                        !device.online -> stringResource(Res.string.musicai_play_on_offline)
                        track != null && device.state.playing -> stringResource(Res.string.musicai_play_on_playing, track.title)
                        track != null -> stringResource(Res.string.musicai_play_on_paused, track.title)
                        else -> stringResource(Res.string.musicai_play_on_online)
                    }
                DeviceRow(
                    icon = if (device.type == "mac" || device.type == "desktop") R.drawable.musicai_laptop else R.drawable.musicai_smartphone,
                    name = device.name,
                    subtitle = subtitle,
                    enabled = device.online,
                    onClick = {
                        scope.launch {
                            if (sync.playOn(device)) {
                                onDismiss()
                            } else {
                                Toast.makeText(context, failedText, Toast.LENGTH_SHORT).show()
                            }
                        }
                    },
                    trailing =
                        if (track != null) {
                            {
                                TextButton(onClick = {
                                    sync.continueFrom(device)
                                    onDismiss()
                                }) { Text(stringResource(Res.string.musicai_play_on_continue_here)) }
                            }
                        } else {
                            null
                        },
                )
            }
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun DeviceRow(
    icon: Int,
    name: String,
    subtitle: String,
    enabled: Boolean,
    onClick: () -> Unit,
    trailing: (@Composable () -> Unit)?,
) {
    val contentColor =
        if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier =
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .clickable(enabled = enabled, onClick = onClick)
                .padding(horizontal = 8.dp, vertical = 10.dp),
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = contentColor, modifier = Modifier.size(26.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.titleMedium, color = contentColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        trailing?.invoke()
    }
}
