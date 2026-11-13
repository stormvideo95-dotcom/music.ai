/**
 * Music AI (fork of Metrolist) — Taste AI settings
 * Licensed under GPL-3.0
 */

package com.metrolist.music.ui.screens.settings

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.metrolist.music.LocalDatabase
import com.metrolist.music.LocalPlayerConnection
import com.metrolist.music.tasteai.PairResult
import com.metrolist.music.tasteai.AiMixes
import com.metrolist.music.tasteai.PiState
import com.metrolist.music.tasteai.PiStatusDot
import com.metrolist.music.tasteai.TasteAiStatus
import com.metrolist.music.tasteai.piStateLabel
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import com.metrolist.music.R
import com.metrolist.music.constants.TasteAiEnabledKey
import com.metrolist.music.constants.TasteAiUrlKey
import com.metrolist.music.tasteai.TasteAiManager
import com.metrolist.music.ui.component.Material3SettingsGroup
import com.metrolist.music.ui.component.Material3SettingsItem
import com.metrolist.music.ui.component.TextFieldDialog
import com.metrolist.music.utils.rememberPreference
import kotlinx.coroutines.launch

private sealed interface TestState {
    data object Idle : TestState

    data object Checking : TestState

    data class Ok(val events: Int, val trained: Boolean) : TestState

    data object Failed : TestState
}

@Composable
fun TasteAiSettingsSection() {
    val (enabled, onEnabledChange) = rememberPreference(TasteAiEnabledKey, defaultValue = false)
    val (url, onUrlChange) = rememberPreference(TasteAiUrlKey, defaultValue = "")
    var showUrlDialog by remember { mutableStateOf(false) }
    var testState by remember { mutableStateOf<TestState>(TestState.Idle) }
    val coroutineScope = rememberCoroutineScope()
    val context = LocalContext.current
    val database = LocalDatabase.current
    val piState by TasteAiStatus.state.collectAsStateWithLifecycle()
    var mixesText by remember { mutableStateOf<String?>(null) }
    var mixesBusy by remember { mutableStateOf(false) }
    val deviceSync = LocalPlayerConnection.current?.service?.deviceSync
    val paired by (deviceSync?.paired ?: kotlinx.coroutines.flow.MutableStateFlow(false)).collectAsStateWithLifecycle()
    var pairText by remember { mutableStateOf<String?>(null) }
    var pairBusy by remember { mutableStateOf(false) }
    var showCodeDialog by remember { mutableStateOf(false) }
    var addText by remember { mutableStateOf<String?>(null) }

    if (showCodeDialog && deviceSync != null) {
        TextFieldDialog(
            title = { Text(stringResource(R.string.pair_add_device)) },
            icon = { Icon(painterResource(R.drawable.devices), null) },
            initialTextFieldValue = TextFieldValue(""),
            placeholder = { Text(stringResource(R.string.pair_code)) },
            keyboardType = KeyboardType.Number,
            isInputValid = { it.trim().length == 6 && it.trim().all(Char::isDigit) },
            onDone = { code ->
                showCodeDialog = false
                coroutineScope.launch {
                    addText =
                        when (deviceSync.approve(code)) {
                            PairResult.PAIRED -> context.getString(R.string.pair_added)
                            PairResult.WRONG_CODE -> context.getString(R.string.pair_wrong_code)
                            PairResult.OFFLINE -> context.getString(R.string.taste_ai_test_fail)
                        }
                }
            },
            onDismiss = { showCodeDialog = false },
        )
    }

    LaunchedEffect(enabled, url) {
        while (true) {
            if (enabled && url.isNotBlank()) {
                val health = TasteAiManager.health(url)
                TasteAiStatus.set(if (health?.ok == true) PiState.ONLINE else PiState.OFFLINE)
            } else {
                TasteAiStatus.set(PiState.OFF)
            }
            delay(30_000)
        }
    }

    if (showUrlDialog) {
        TextFieldDialog(
            title = { Text(stringResource(R.string.taste_ai_server)) },
            icon = { Icon(painterResource(R.drawable.link), null) },
            initialTextFieldValue = TextFieldValue(text = url.ifBlank { "http://" }),
            placeholder = { Text(stringResource(R.string.taste_ai_server_hint)) },
            keyboardType = KeyboardType.Uri,
            isInputValid = { it.startsWith("http://") || it.startsWith("https://") },
            onDone = {
                onUrlChange(it.trim())
                testState = TestState.Idle
                showUrlDialog = false
            },
            onDismiss = { showUrlDialog = false },
        )
    }

    Material3SettingsGroup(
        title = stringResource(R.string.taste_ai),
        items =
            listOf(
                Material3SettingsItem(
                    icon = painterResource(R.drawable.discover_tune),
                    title = { Text(stringResource(R.string.taste_ai_enable)) },
                    description = { Text(stringResource(R.string.taste_ai_enable_desc)) },
                    trailingContent = {
                        Switch(
                            checked = enabled,
                            onCheckedChange = onEnabledChange,
                            thumbContent = {
                                Icon(
                                    painter = painterResource(if (enabled) R.drawable.check else R.drawable.close),
                                    contentDescription = null,
                                    modifier = Modifier.size(SwitchDefaults.IconSize),
                                )
                            },
                        )
                    },
                    onClick = { onEnabledChange(!enabled) },
                ),
                Material3SettingsItem(
                    icon = painterResource(R.drawable.link),
                    title = { Text(stringResource(R.string.taste_ai_server)) },
                    description = { Text(url.ifBlank { stringResource(R.string.not_set) }) },
                    onClick = { showUrlDialog = true },
                ),
                Material3SettingsItem(
                    icon = painterResource(R.drawable.sync),
                    title = { Text(stringResource(R.string.taste_ai_test)) },
                    description = {
                        Text(
                            when (val s = testState) {
                                TestState.Idle -> stringResource(R.string.taste_ai_test_idle)
                                TestState.Checking -> stringResource(R.string.taste_ai_test_checking)
                                is TestState.Ok -> stringResource(R.string.taste_ai_test_ok, s.events, if (s.trained) "yes" else "not yet")
                                TestState.Failed -> stringResource(R.string.taste_ai_test_fail)
                            },
                        )
                    },
                    enabled = url.isNotBlank() && testState != TestState.Checking,
                    onClick = {
                        testState = TestState.Checking
                        coroutineScope.launch {
                            val health = TasteAiManager.health(url)
                            testState = if (health?.ok == true) TestState.Ok(health.events, health.trained) else TestState.Failed
                            TasteAiStatus.set(if (health?.ok == true) PiState.ONLINE else PiState.OFFLINE)
                        }
                    },
                ),
                Material3SettingsItem(
                    icon = painterResource(R.drawable.cloud),
                    title = { Text(stringResource(R.string.taste_ai_status)) },
                    description = { Text(piStateLabel(piState)) },
                    trailingContent = { PiStatusDot(piState) },
                ),
                Material3SettingsItem(
                    icon = painterResource(R.drawable.smartphone),
                    title = { Text(stringResource(if (paired) R.string.pair_paired else R.string.pair_this_phone)) },
                    description = { Text(pairText ?: stringResource(R.string.pair_this_phone_desc)) },
                    enabled = deviceSync != null && url.isNotBlank() && !pairBusy && !paired,
                    onClick = {
                        pairBusy = true
                        coroutineScope.launch {
                            val sync = deviceSync ?: return@launch
                            val res = sync.pairStart(url)
                            when {
                                res == null -> pairText = context.getString(R.string.taste_ai_test_fail)
                                res.approved -> pairText = null
                                res.code != null && res.pairId != null -> {
                                    pairText = context.getString(R.string.pair_code_show, res.code)
                                    val ok = sync.pairWait(url, res.pairId)
                                    pairText = if (ok) null else context.getString(R.string.pair_wrong_code)
                                }
                            }
                            pairBusy = false
                        }
                    },
                ),
                Material3SettingsItem(
                    icon = painterResource(R.drawable.laptop),
                    title = { Text(stringResource(R.string.pair_add_device)) },
                    description = { Text(addText ?: stringResource(R.string.pair_add_device_desc)) },
                    enabled = deviceSync != null && paired,
                    onClick = { showCodeDialog = true },
                ),
                Material3SettingsItem(
                    icon = painterResource(R.drawable.queue_music),
                    title = { Text(stringResource(R.string.taste_ai_mixes_refresh)) },
                    description = { Text(mixesText ?: stringResource(R.string.taste_ai_mixes_desc)) },
                    enabled = url.isNotBlank() && !mixesBusy,
                    onClick = {
                        mixesBusy = true
                        mixesText = context.getString(R.string.taste_ai_mixes_working)
                        coroutineScope.launch {
                            val result = AiMixes.refresh(context, database, url)
                            mixesText =
                                when {
                                    result == null -> context.getString(R.string.taste_ai_test_fail)
                                    !result.ready -> context.getString(R.string.taste_ai_mixes_not_ready, result.likedSongs, result.needed)
                                    else -> context.getString(R.string.taste_ai_mixes_done, result.mixes.size)
                                }
                            mixesBusy = false
                        }
                    },
                ),
            ),
    )
}
