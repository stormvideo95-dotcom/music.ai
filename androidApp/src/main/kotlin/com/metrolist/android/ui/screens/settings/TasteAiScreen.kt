/**
 * Music AI (fork of Metrolist) — Taste AI settings
 * Licensed under GPL-3.0
 */

package com.metrolist.android.ui.screens.settings

import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import com.metrolist.android.tasteai.AiMixes
import com.metrolist.android.tasteai.MusicAi
import com.metrolist.android.tasteai.PairResult
import com.metrolist.android.tasteai.PiState
import com.metrolist.android.tasteai.PiStatusDot
import com.metrolist.android.tasteai.TasteAiManager
import com.metrolist.android.tasteai.TasteAiStatus
import com.metrolist.android.tasteai.piStateLabel
import com.metrolist.shared.db.MusicDatabase
import com.metrolist.shared.generated.resources.Res
import com.metrolist.shared.generated.resources.musicai_cancel
import com.metrolist.shared.generated.resources.musicai_enable
import com.metrolist.shared.generated.resources.musicai_enable_desc
import com.metrolist.shared.generated.resources.musicai_mixes_desc
import com.metrolist.shared.generated.resources.musicai_mixes_done
import com.metrolist.shared.generated.resources.musicai_mixes_not_ready
import com.metrolist.shared.generated.resources.musicai_mixes_refresh
import com.metrolist.shared.generated.resources.musicai_mixes_working
import com.metrolist.shared.generated.resources.musicai_not_set
import com.metrolist.shared.generated.resources.musicai_not_yet
import com.metrolist.shared.generated.resources.musicai_ok
import com.metrolist.shared.generated.resources.musicai_pair_add_device
import com.metrolist.shared.generated.resources.musicai_pair_add_device_desc
import com.metrolist.shared.generated.resources.musicai_pair_added
import com.metrolist.shared.generated.resources.musicai_pair_code
import com.metrolist.shared.generated.resources.musicai_pair_code_show
import com.metrolist.shared.generated.resources.musicai_pair_paired
import com.metrolist.shared.generated.resources.musicai_pair_this_phone
import com.metrolist.shared.generated.resources.musicai_pair_this_phone_desc
import com.metrolist.shared.generated.resources.musicai_pair_wrong_code
import com.metrolist.shared.generated.resources.musicai_server
import com.metrolist.shared.generated.resources.musicai_server_hint
import com.metrolist.shared.generated.resources.musicai_status
import com.metrolist.shared.generated.resources.musicai_taste_ai
import com.metrolist.shared.generated.resources.musicai_test
import com.metrolist.shared.generated.resources.musicai_test_checking
import com.metrolist.shared.generated.resources.musicai_test_fail
import com.metrolist.shared.generated.resources.musicai_test_idle
import com.metrolist.shared.generated.resources.musicai_test_ok
import com.metrolist.shared.generated.resources.musicai_yes
import com.metrolist.shared.settings.Settings
import com.metrolist.shared.ui.components.AlertDialog
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import org.koin.compose.koinInject

private sealed interface TestState {
    data object Idle : TestState

    data object Checking : TestState

    data class Ok(
        val events: Int,
        val trained: Boolean,
    ) : TestState

    data object Failed : TestState
}

@Composable
fun TasteAiScreen(onNavigateBack: () -> Unit) {
    val settings = Settings.shared
    val enabled = settings.tasteAiEnabled
    val url = settings.tasteAiUrl
    val paired = settings.tasteAiDeviceToken.isNotBlank()
    val database = koinInject<MusicDatabase>()
    val deviceSync = MusicAi.deviceSync.collectAsState().value
    val piState by TasteAiStatus.state.collectAsState()
    val scope = rememberCoroutineScope()

    var testState by remember { mutableStateOf<TestState>(TestState.Idle) }
    var mixesText by remember { mutableStateOf<String?>(null) }
    var mixesBusy by remember { mutableStateOf(false) }
    var pairText by remember { mutableStateOf<String?>(null) }
    var pairBusy by remember { mutableStateOf(false) }
    var addText by remember { mutableStateOf<String?>(null) }
    var showUrlDialog by remember { mutableStateOf(false) }
    var showCodeDialog by remember { mutableStateOf(false) }

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
        TextInputDialog(
            title = stringResource(Res.string.musicai_server),
            initial = url.ifBlank { "http://" },
            placeholder = stringResource(Res.string.musicai_server_hint),
            keyboardType = KeyboardType.Uri,
            isValid = { it.startsWith("http://") || it.startsWith("https://") },
            onDone = {
                settings.tasteAiUrl = it.trim()
                testState = TestState.Idle
                showUrlDialog = false
            },
            onDismiss = { showUrlDialog = false },
        )
    }

    if (showCodeDialog && deviceSync != null) {
        TextInputDialog(
            title = stringResource(Res.string.musicai_pair_add_device),
            initial = "",
            placeholder = stringResource(Res.string.musicai_pair_code),
            keyboardType = KeyboardType.Number,
            isValid = { it.trim().length == 6 && it.trim().all(Char::isDigit) },
            onDone = { code ->
                showCodeDialog = false
                scope.launch {
                    addText =
                        when (deviceSync.approve(code)) {
                            PairResult.PAIRED -> getString(Res.string.musicai_pair_added)
                            PairResult.WRONG_CODE -> getString(Res.string.musicai_pair_wrong_code)
                            PairResult.OFFLINE -> getString(Res.string.musicai_test_fail)
                        }
                }
            },
            onDismiss = { showCodeDialog = false },
        )
    }

    val testDescription =
        when (val s = testState) {
            TestState.Idle -> {
                stringResource(Res.string.musicai_test_idle)
            }

            TestState.Checking -> {
                stringResource(Res.string.musicai_test_checking)
            }

            is TestState.Ok -> {
                stringResource(
                    Res.string.musicai_test_ok,
                    s.events,
                    stringResource(if (s.trained) Res.string.musicai_yes else Res.string.musicai_not_yet),
                )
            }

            TestState.Failed -> {
                stringResource(Res.string.musicai_test_fail)
            }
        }

    SettingsSubScreen(
        title = stringResource(Res.string.musicai_taste_ai),
        onNavigateBack = onNavigateBack,
    ) {
        SettingsSubScreenGroup(
            items =
                listOf(
                    switchSettingsItem(
                        title = stringResource(Res.string.musicai_enable),
                        description = stringResource(Res.string.musicai_enable_desc),
                        checked = enabled,
                        onCheckedChange = { settings.tasteAiEnabled = it },
                    ),
                    SettingsSubScreenItem(
                        title = stringResource(Res.string.musicai_server),
                        description = url.ifBlank { stringResource(Res.string.musicai_not_set) },
                        onClick = { showUrlDialog = true },
                    ),
                    SettingsSubScreenItem(
                        title = stringResource(Res.string.musicai_test),
                        description = testDescription,
                        enabled = url.isNotBlank() && testState != TestState.Checking,
                        onClick = {
                            testState = TestState.Checking
                            scope.launch {
                                val health = TasteAiManager.health(url)
                                testState = if (health?.ok == true) TestState.Ok(health.events, health.trained) else TestState.Failed
                                TasteAiStatus.set(if (health?.ok == true) PiState.ONLINE else PiState.OFFLINE)
                            }
                        },
                    ),
                    SettingsSubScreenItem(
                        title = stringResource(Res.string.musicai_status),
                        description = piStateLabel(piState),
                        trailingContent = { PiStatusDot(piState) },
                    ),
                ),
        )
        SettingsSubScreenGroup(
            items =
                listOf(
                    SettingsSubScreenItem(
                        title = stringResource(if (paired) Res.string.musicai_pair_paired else Res.string.musicai_pair_this_phone),
                        description = pairText ?: stringResource(Res.string.musicai_pair_this_phone_desc),
                        enabled = deviceSync != null && url.isNotBlank() && !pairBusy && !paired,
                        onClick = {
                            val sync = deviceSync
                            pairBusy = sync != null
                            if (sync != null) scope.launch {
                                val res = sync.pairStart(url)
                                when {
                                    res == null -> {
                                        pairText = getString(Res.string.musicai_test_fail)
                                    }

                                    res.approved -> {
                                        pairText = null
                                    }

                                    res.code != null && res.pairId != null -> {
                                        pairText = getString(Res.string.musicai_pair_code_show, res.code)
                                        val ok = sync.pairWait(url, res.pairId)
                                        pairText = if (ok) null else getString(Res.string.musicai_pair_wrong_code)
                                    }
                                }
                                pairBusy = false
                            }
                        },
                    ),
                    SettingsSubScreenItem(
                        title = stringResource(Res.string.musicai_pair_add_device),
                        description = addText ?: stringResource(Res.string.musicai_pair_add_device_desc),
                        enabled = deviceSync != null && paired,
                        onClick = { showCodeDialog = true },
                    ),
                    SettingsSubScreenItem(
                        title = stringResource(Res.string.musicai_mixes_refresh),
                        description = mixesText ?: stringResource(Res.string.musicai_mixes_desc),
                        enabled = url.isNotBlank() && !mixesBusy,
                        onClick = {
                            mixesBusy = true
                            scope.launch {
                                mixesText = getString(Res.string.musicai_mixes_working)
                                val result = AiMixes.refresh(database, url)
                                mixesText =
                                    when {
                                        result == null -> getString(Res.string.musicai_test_fail)
                                        !result.ready -> getString(Res.string.musicai_mixes_not_ready, result.likedSongs, result.needed)
                                        else -> getString(Res.string.musicai_mixes_done, result.mixes.size)
                                    }
                                mixesBusy = false
                            }
                        },
                    ),
                ),
        )
    }
}

@Composable
private fun TextInputDialog(
    title: String,
    initial: String,
    placeholder: String,
    keyboardType: KeyboardType,
    isValid: (String) -> Boolean,
    onDone: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var value by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                placeholder = { Text(placeholder) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            )
        },
        confirmButton = {
            TextButton(enabled = isValid(value), onClick = { onDone(value) }) { Text(stringResource(Res.string.musicai_ok)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(Res.string.musicai_cancel)) }
        },
    )
}
