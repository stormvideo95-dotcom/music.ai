/**
 * Music AI (fork of Metrolist) — small "Pi connected / offline" badge
 * Licensed under GPL-3.0
 */

package com.metrolist.android.tasteai

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.metrolist.shared.generated.resources.Res
import com.metrolist.shared.generated.resources.musicai_pi_off
import com.metrolist.shared.generated.resources.musicai_pi_offline
import com.metrolist.shared.generated.resources.musicai_pi_online
import com.metrolist.shared.generated.resources.musicai_test_checking
import org.jetbrains.compose.resources.stringResource

private val PiOnlineColor = Color(0xFF34C759)
private val PiOfflineColor = Color(0xFFFF453A)
private val PiCheckingColor = Color(0xFFFFB020)

@Composable
fun piStateLabel(state: PiState): String =
    when (state) {
        PiState.ONLINE -> stringResource(Res.string.musicai_pi_online)
        PiState.OFFLINE -> stringResource(Res.string.musicai_pi_offline)
        PiState.CHECKING -> stringResource(Res.string.musicai_test_checking)
        PiState.OFF -> stringResource(Res.string.musicai_pi_off)
    }

private fun piStateColor(state: PiState): Color =
    when (state) {
        PiState.ONLINE -> PiOnlineColor
        PiState.OFFLINE -> PiOfflineColor
        PiState.CHECKING -> PiCheckingColor
        PiState.OFF -> Color.Gray
    }

@Composable
fun PiStatusDot(
    state: PiState,
    modifier: Modifier = Modifier,
) {
    Spacer(
        modifier =
            modifier
                .size(8.dp)
                .background(piStateColor(state), CircleShape),
    )
}

/** Shown in the full player. Hidden when Taste AI is off. */
@Composable
fun PiStatusBadge(
    textColor: Color,
    modifier: Modifier = Modifier,
) {
    val state by TasteAiStatus.state.collectAsState()
    if (state == PiState.OFF) return
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PiStatusDot(state)
        Spacer(Modifier.width(6.dp))
        Text(
            text = piStateLabel(state),
            style = MaterialTheme.typography.labelMedium,
            color = textColor.copy(alpha = 0.8f),
        )
    }
}
