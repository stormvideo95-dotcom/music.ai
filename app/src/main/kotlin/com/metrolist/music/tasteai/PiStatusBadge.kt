/**
 * Music AI (fork of Metrolist) — small "Pi connected / offline" badge
 * Licensed under GPL-3.0
 */

package com.metrolist.music.tasteai

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.metrolist.music.R

val PiOnlineColor = Color(0xFF34C759)
val PiOfflineColor = Color(0xFFFF453A)
val PiCheckingColor = Color(0xFFFFB020)

@Composable
fun piStateLabel(state: PiState): String =
    when (state) {
        PiState.ONLINE -> stringResource(R.string.taste_ai_pi_online)
        PiState.OFFLINE -> stringResource(R.string.taste_ai_pi_offline)
        PiState.CHECKING -> stringResource(R.string.taste_ai_test_checking)
        PiState.OFF -> stringResource(R.string.taste_ai_pi_off)
    }

fun piStateColor(state: PiState): Color =
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
    val state by TasteAiStatus.state.collectAsStateWithLifecycle()
    if (state == PiState.OFF) return
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
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
