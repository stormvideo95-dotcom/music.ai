/**
 * Music AI (fork of Metrolist) — Spotify-style "Play on" device picker
 * Licensed under GPL-3.0
 */

package com.metrolist.music.tasteai

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.metrolist.music.LocalPlayerConnection
import com.metrolist.music.R
import com.metrolist.music.ui.component.CastButton
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun DevicesButton(
    modifier: Modifier = Modifier,
    tintColor: Color = MaterialTheme.colorScheme.onSurface,
) {
    var show by remember { mutableStateOf(false) }
    IconButton(onClick = { show = true }, modifier = modifier) {
        Icon(
            painter = painterResource(R.drawable.devices),
            contentDescription = stringResource(R.string.play_on),
            tint = tintColor,
        )
    }
    if (show) DevicePickerSheet(onDismiss = { show = false })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicePickerSheet(onDismiss: () -> Unit) {
    val playerConnection = LocalPlayerConnection.current ?: return
    val sync = playerConnection.service.deviceSync
    val devices by sync.devices.collectAsStateWithLifecycle()
    val paired by sync.paired.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val failedText = stringResource(R.string.play_on_failed)

    LaunchedEffect(paired) {
        while (true) {
            sync.refreshDevices()
            delay(5_000)
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 24.dp)
                    .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = stringResource(R.string.play_on),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(bottom = 12.dp),
            )

            DeviceRow(
                icon = R.drawable.smartphone,
                name = stringResource(R.string.play_on_this_phone),
                subtitle = stringResource(R.string.play_on_playing_here),
                selected = true,
            )

            val others = devices.filter { !it.me }
            if (!paired) {
                Text(
                    text = stringResource(R.string.play_on_not_paired),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
            } else if (others.isEmpty()) {
                Text(
                    text = stringResource(R.string.play_on_no_devices),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
            }

            others.forEach { device ->
                val track = device.state.track
                val subtitle =
                    when {
                        !device.online -> stringResource(R.string.play_on_offline)
                        track != null && device.state.playing -> stringResource(R.string.play_on_playing, track.title)
                        track != null -> stringResource(R.string.play_on_paused, track.title)
                        else -> stringResource(R.string.play_on_online)
                    }
                DeviceRow(
                    icon = if (device.type == "mac" || device.type == "desktop") R.drawable.laptop else R.drawable.smartphone,
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
                                }) { Text(stringResource(R.string.play_on_continue_here)) }
                            }
                        } else {
                            null
                        },
                )
            }

            Text(
                text = stringResource(R.string.play_on_chromecast),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 4.dp),
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                CastButton(tintColor = MaterialTheme.colorScheme.onSurface)
                Text(
                    text = stringResource(R.string.play_on_chromecast_hint),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun DeviceRow(
    icon: Int,
    name: String,
    subtitle: String,
    selected: Boolean = false,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val accent = MaterialTheme.colorScheme.primary
    val contentColor =
        when {
            selected -> accent
            !enabled -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
            else -> MaterialTheme.colorScheme.onSurface
        }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier =
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .then(if (selected) Modifier.background(accent.copy(alpha = 0.12f)) else Modifier)
                .then(if (onClick != null && enabled) Modifier.clickable(onClick = onClick) else Modifier)
                .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = contentColor, modifier = Modifier.size(26.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.titleMedium, color = contentColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = if (selected) accent else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        trailing?.invoke()
    }
}
