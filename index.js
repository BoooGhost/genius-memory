// index.js - 확장 프로그램 시작점 및 버튼/실리태번 이벤트 연결
import { extension_settings, getContext } from "../../../extensions.js";
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    saveChatConditional
} from "../../../../script.js";
import {
    extensionName,
    extensionFolderPath,
    runtime,
    getChatGMData,
    isRoomEnabled,
    setMessagesHidden,
    unhideRangeAndDivider
} from "./state.js";
import {
    syncSidebarToViewport,
    loadSettingsUI,
    injectSceneButtons,
    updateRangeHighlight,
    clearRangeSelection,
    renderMacroChunkSlots,
    renderAllDividers,
    renderLorebookList,
    updatePromptInjection,
    refreshUIAndPrompt,
    autoSaveIfDirty
} from "./ui.js";
import {
    consolidateChunksToMaster,
    summarizeLoreEventRange,
    detectEventsOnTurn,
    summarizeSelectedRange,
    runBatchOrAutoSummary
} from "./summarizer.js";

function setupListeners() {
    async function setCurrentRoomEnabled(newState) {
        const gmData = getChatGMData();
        if (gmData) {
            gmData.room_enabled = newState;
            await saveChatConditional();
        } else {
            extension_settings[extensionName].enabled = newState;
            saveSettingsDebounced();
        }
        await refreshUIAndPrompt();
        toastr.info(
            newState ? "이 채팅방에서 Genius Memory가 켜졌습니다. (🟢 ON)" : "이 채팅방에서 Genius Memory가 꺼졌습니다. (⚪ OFF)",
            "Genius Memory",
            { timeOut: 1500 }
        );
    }

    $("#gm_enabled").on("change", function () {
        setCurrentRoomEnabled($(this).prop("checked"));
    });

    $(document).on("click", "#gm-room-toggle-btn", function () {
        setCurrentRoomEnabled(!isRoomEnabled());
    });

    $("#gm_api_url").on("input", function () {
        extension_settings[extensionName].api_url = $(this).val().trim();
        saveSettingsDebounced();
    });
    $("#gm_api_key").on("input", function () {
        extension_settings[extensionName].api_key = $(this).val().trim();
        saveSettingsDebounced();
    });
    $("#gm_model").on("input", function () {
        extension_settings[extensionName].model = $(this).val().trim();
        saveSettingsDebounced();
    });
    $("#gm_chunk_size").on("input", function () {
        extension_settings[extensionName].chunk_size = Number($(this).val());
        saveSettingsDebounced();
    });
    $("#gm_buffer_size").on("input", function () {
        extension_settings[extensionName].buffer_size = Number($(this).val());
        saveSettingsDebounced();
    });
    $("#gm_consolidate_count").on("input", function () {
        extension_settings[extensionName].consolidate_count = Number($(this).val());
        saveSettingsDebounced();
        refreshUIAndPrompt();
    });
    $("#gm_recall_top_k").on("input", function () {
        extension_settings[extensionName].recall_top_k = Number($(this).val());
        saveSettingsDebounced();
        refreshUIAndPrompt();
    });
    $("#gm_embed_model").on("input", function () {
        extension_settings[extensionName].embed_model = $(this).val().trim();
        saveSettingsDebounced();
    });
    $("#gm_auto_detect_events").on("change", function () {
        extension_settings[extensionName].auto_detect_events = $(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#gm-close-btn").on("click", async function () {
        $("#gm-sidebar").removeClass("gm-open");
        await autoSaveIfDirty(true);
    });

    $(document).on("click", "#gm-bookmark-btn", function () {
        $(".gm-drawer-layer").toggleClass("gm-open");
    });

    $(document).on("click", ".gm-tab-btn", function () {
        $(".gm-tab-btn").removeClass("active");
        $(this).addClass("active");
        $(".gm-tab-pane").removeClass("active");
        $(`#${$(this).attr("data-tab")}`).addClass("active");
    });

    $(document).on("click", ".gm-fold-header", function (e) {
        if ($(e.target).closest(".gm-lore-del, .gm-clear-chunk-btn, button").length > 0) return;
        const box = $(this).closest(".gm-fold-box");
        box.toggleClass("gm-collapsed");

        if (!box.hasClass("gm-collapsed")) {
            const loreTextarea = box.find(".gm-lore-content")[0];
            if (loreTextarea) {
                loreTextarea.style.height = "auto";
                loreTextarea.style.height = Math.min(360, Math.max(220, loreTextarea.scrollHeight + 12)) + "px";
            }
            const chunkTextarea = box.find(".gm-chunk-input")[0];
            if (chunkTextarea) {
                chunkTextarea.style.height = "auto";
                chunkTextarea.style.height = Math.min(280, Math.max(130, chunkTextarea.scrollHeight + 12)) + "px";
            }
        }
    });

    $(document).on("click", ".gm-clear-chunk-btn", async function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        if (!gmData || !gmData.macro_chunks[idx]) return;

        const targetChunk = gmData.macro_chunks[idx];
        if (targetChunk.range) {
            unhideRangeAndDivider(gmData, targetChunk.range);
        }

        gmData.macro_chunks.splice(idx, 1);
        await saveChatConditional();

        const s = extension_settings[extensionName];
        $("#gm-chunk-counter").text(`(조각: ${gmData.macro_chunks.length}/${s.consolidate_count})`);
        renderMacroChunkSlots(gmData);
        renderAllDividers(gmData.dividers);
        await updatePromptInjection(gmData);
        toastr.info(`#${idx + 1}번째 요약 조각을 비우고 해당 턴 숨김을 해제했습니다.`, "🗑️ 비우기 완료");
    });

    // '<' (시작점) 버튼: 부모 .mes에서 실시간으로 턴 번호 조회
    $(document).on("click", ".gm-set-start", function (e) {
        e.stopPropagation();
        const mesId = Number($(this).closest(".mes").attr("mesid"));
        if (isNaN(mesId)) return;

        runtime.selectedStartIdx = mesId;
        if (runtime.selectedEndIdx !== null && runtime.selectedEndIdx < runtime.selectedStartIdx) {
            runtime.selectedEndIdx = runtime.selectedStartIdx;
        }
        updateRangeHighlight();
        syncSidebarToViewport();
        $("#gm-sidebar").addClass("gm-open");
        $(".gm-drawer-layer").addClass("gm-open");
        toastr.info(`요약 시작점: ${runtime.selectedStartIdx}턴 선택됨`, "Genius Memory", { timeOut: 1500 });
    });

    // '>' (끝점) 버튼: 시작점이 비어 있으면 첫 미요약 턴(기본 0턴)을 자동 선택 (9~9턴 현상 방지)
    $(document).on("click", ".gm-set-end", function (e) {
        e.stopPropagation();
        const mesId = Number($(this).closest(".mes").attr("mesid"));
        if (isNaN(mesId)) return;

        runtime.selectedEndIdx = mesId;
        if (runtime.selectedStartIdx === null) {
            const context = getContext();
            const chat = context?.chat || [];
            let defaultStart = 0;
            for (let i = 0; i <= mesId; i++) {
                if (chat[i] && !chat[i].is_system && !chat[i].extra?.isSmallSys) {
                    defaultStart = i;
                    break;
                }
            }
            runtime.selectedStartIdx = defaultStart;
        } else if (runtime.selectedStartIdx > runtime.selectedEndIdx) {
            runtime.selectedStartIdx = 0;
        }
        updateRangeHighlight();
        syncSidebarToViewport();
        $("#gm-sidebar").addClass("gm-open");
        $(".gm-drawer-layer").addClass("gm-open");
        toastr.info(`요약 구간: ${runtime.selectedStartIdx} ~ ${runtime.selectedEndIdx}턴 선택됨`, "Genius Memory", { timeOut: 1500 });
    });

    $("#gm-start-turn").on("input", function () {
        const raw = String($(this).val() ?? "").trim();
        runtime.selectedStartIdx = (raw !== "" && !isNaN(Number(raw)) && Number(raw) >= 0) ? Number(raw) : null;
        updateRangeHighlight();
    });
    $("#gm-end-turn").on("input", function () {
        const raw = String($(this).val() ?? "").trim();
        runtime.selectedEndIdx = (raw !== "" && !isNaN(Number(raw)) && Number(raw) >= 0) ? Number(raw) : null;
        updateRangeHighlight();
    });

    $("#gm-clear-range-btn").on("click", clearRangeSelection);
    $("#gm-range-sum-btn").on("click", summarizeSelectedRange);
    $("#gm-batch-sum-btn").on("click", () => runBatchOrAutoSummary(true));

    $("#gm-range-lore-btn").on("click", async function () {
        const startRaw = String($("#gm-start-turn").val() ?? "").trim();
        const endRaw = String($("#gm-end-turn").val() ?? "").trim();
        if (startRaw === "" || endRaw === "" || isNaN(Number(startRaw)) || isNaN(Number(endRaw)) || Number(startRaw) > Number(endRaw)) {
            return toastr.warning("올바른 시작~끝 턴을 먼저 지정해주세요. (0턴부터 입력 가능)", "Genius Memory");
        }
        const customTitle = prompt("이 구간의 사건 제목을 입력해주세요 (비워두면 AI가 자동 작성):", "");
        if (customTitle === null) return;
        $(".gm-drawer-layer").removeClass("gm-open");
        await summarizeLoreEventRange(customTitle.trim(), Number(startRaw), Number(endRaw));
        clearRangeSelection();
    });

    $("#gm-manual-merge-btn").on("click", async function () {
        const gmData = getChatGMData();
        if (!gmData || gmData.macro_chunks.length === 0) {
            return toastr.warning("합칠 요약 조각이 없습니다.", "Genius Memory");
        }
        try {
            await consolidateChunksToMaster(gmData);
            await saveChatConditional();
            await refreshUIAndPrompt();
            toastr.success("요약 조각들이 통합 전체 요약으로 합쳐졌습니다!", "🧠 Genius Memory");
        } catch (err) {
            toastr.error(err.message, "통합 오류");
        }
    });

    $(document).on("click", ".gm-summary-divider", async function () {
        const startIdx = Number($(this).attr("data-start"));
        const endIdx = Number($(this).attr("data-end"));
        const context = getContext();
        const gmData = getChatGMData();
        if (!context?.chat || !gmData) return;

        const indices = [];
        for (let i = startIdx; i <= endIdx; i++) indices.push(i);
        setMessagesHidden(context.chat, indices, false);

        gmData.dividers = gmData.dividers.filter(d => d.mesId !== endIdx);
        await saveChatConditional();
        await refreshUIAndPrompt();
        toastr.info(`${startIdx} ~ ${endIdx}턴 메시지의 숨김 처리가 해제되었습니다.`, "Genius Memory");
    });

    $(document).on("input", "#gm-macro-summary, .gm-chunk-input, #gm-state-tracker, #gm-open-tracker, #gm-items-tracker", function () {
        runtime.isStateDirty = true;
        $("#gm-rollback-state-btn").addClass("gm-has-unsaved");

        if ($(this).hasClass("gm-chunk-input") && $(this).val().trim() === "") {
            const idx = Number($(this).attr("data-idx"));
            $(this).attr("data-range", "");
            const slot = $(this).closest(".gm-chunk-slot");
            slot.find(".gm-chunk-title-text").text(`#${idx + 1}번째 조각 (비어 있음)`).css("color", "#777");
            slot.find(".gm-clear-chunk-btn").remove();
        }
    });

    $(document).on("input", ".gm-lore-title, .gm-lore-keys-only, .gm-lore-content", function () {
        runtime.isLoreDirty = true;
        $("#gm-rollback-lore-btn").addClass("gm-has-unsaved");
    });

    $("#gm-rollback-state-btn").on("click", function () {
        if (!runtime.isStateDirty) return toastr.info("되돌릴 수정사항이 없습니다.", "Genius Memory", { timeOut: 1200 });
        runtime.isStateDirty = false;
        $("#gm-rollback-state-btn").removeClass("gm-has-unsaved");
        refreshUIAndPrompt();
        toastr.info("수정을 취소하고 마지막 저장값으로 되돌렸습니다.", "↩️ 롤백 완료");
    });

    $("#gm-rollback-lore-btn").on("click", function () {
        if (!runtime.isLoreDirty) return toastr.info("되돌릴 로어북 수정사항이 없습니다.", "Genius Memory", { timeOut: 1200 });
        runtime.isLoreDirty = false;
        $("#gm-rollback-lore-btn").removeClass("gm-has-unsaved");
        const gmData = getChatGMData();
        if (gmData) renderLorebookList(gmData);
        toastr.info("로어북 수정을 취소하고 마지막 저장값으로 되돌렸습니다.", "↩️ 롤백 완료");
    });

    $("#gm-add-ongoing-btn").on("click", async function () {
        const gmData = getChatGMData();
        const context = getContext();
        if (!gmData || !context?.chat) return;
        const defaultTurn = Math.max(0, context.chat.length - 1);
        const title = prompt("현재 시작된 사건의 이름을 입력하세요 (예: 점심 식사):", "");
        if (!title) return;
        const turnInput = prompt(`몇 번째 턴부터 시작되었나요? (현재 마지막 턴: ${defaultTurn})`, String(defaultTurn));
        const sTurn = (turnInput !== null && turnInput.trim() !== "" && !isNaN(Number(turnInput))) ? Number(turnInput) : defaultTurn;

        gmData.ongoing_events.push({ title: title.trim(), startTurn: sTurn });
        await saveChatConditional();
        renderLorebookList(gmData);
    });

    $(document).on("click", ".gm-finish-event-btn", async function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        const context = getContext();
        if (!gmData || !context?.chat) return;

        const targetEvent = gmData.ongoing_events[idx];
        if (!targetEvent) return;
        const currentLastTurn = Math.max(0, context.chat.length - 1);
        const endTurn = Math.max(targetEvent.startTurn, currentLastTurn);

        gmData.ongoing_events.splice(idx, 1);
        renderLorebookList(gmData);
        await summarizeLoreEventRange(targetEvent.title, targetEvent.startTurn, endTurn);
    });

    $(document).on("click", ".gm-ongoing-del", async function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        if (!gmData) return;
        gmData.ongoing_events.splice(idx, 1);
        await saveChatConditional();
        renderLorebookList(gmData);
    });

    $("#gm-add-lore-btn").on("click", function () {
        const gmData = getChatGMData();
        if (!gmData) return;
        gmData.micro_events.push({ title: "수동 사건", startTurn: "수동", endTurn: "기록", keys: [], content: "", vector: [] });
        renderLorebookList(gmData);
    });

    $(document).on("click", ".gm-lore-del", async function (e) {
        e.stopPropagation();
        if (runtime.isDeletingLore) return;
        runtime.isDeletingLore = true;

        const card = $(this).closest(".gm-lore-card");
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        if (!gmData) {
            runtime.isDeletingLore = false;
            return;
        }

        card.addClass("gm-deleting");
        card.find(".gm-lore-badge").text("⏳ 삭제 중...");

        try {
            gmData.micro_events.splice(idx, 1);
            await saveChatConditional();
            await updatePromptInjection(gmData);
        } finally {
            runtime.isDeletingLore = false;
        }
    });

    $("#gm-export-btn").on("click", async function () {
        await autoSaveIfDirty(false);
        const gmData = getChatGMData();
        if (!gmData) return toastr.warning("내보낼 채팅 데이터가 없습니다.");
        const blob = new Blob([JSON.stringify(gmData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `GeniusMemory_Backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success("기억 백업 파일(.json)이 다운로드되었습니다!", "Genius Memory");
    });

    $("#gm-import-btn").on("click", () => $("#gm-import-file").click());

    $("#gm-import-file").on("change", function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                const context = getContext();
                if (!context?.chatMetadata) return;
                context.chatMetadata.genius_memory = imported;
                runtime.isStateDirty = false;
                runtime.isLoreDirty = false;
                await saveChatConditional();
                await refreshUIAndPrompt();
                toastr.success("백업 데이터를 성공적으로 복원했습니다!", "🧠 Genius Memory");
            } catch (err) {
                toastr.error("잘못된 백업 파일입니다: " + err.message, "복원 실패");
            }
        };
        reader.readAsText(file);
        $(this).val("");
    });
}

function addToWandMenu() {
    if ($("#gm_wand_button").length > 0) return;

    const wandItemHtml = `
        <div id="gm_wand_button" class="list-group-item flex-container flexGap5 interactable" title="Genius Memory 상태창 열기/닫기">
            <div class="fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span>Genius Memory 상태창</span>
        </div>
    `;
    $("#extensionsMenu").append(wandItemHtml);

    $("#gm_wand_button").on("click", async function () {
        const isClosing = $("#gm-sidebar").hasClass("gm-open");
        if (!isClosing) syncSidebarToViewport();
        $("#gm-sidebar").toggleClass("gm-open");
        if (isClosing) await autoSaveIfDirty(true);
    });
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        const $parsed = $(settingsHtml);

        $("#extensions_settings").append($parsed.filter(".genius-memory-settings"));
        $("body").append($parsed.filter("#gm-sidebar"));

        loadSettingsUI();
        setupListeners();
        addToWandMenu();
        syncSidebarToViewport();

        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", syncSidebarToViewport);
            window.visualViewport.addEventListener("scroll", syncSidebarToViewport);
        } else {
            window.addEventListener("resize", syncSidebarToViewport);
        }

        eventSource.on(event_types.CHAT_CHANGED, () => {
            clearRangeSelection();
            runtime.isStateDirty = false;
            runtime.isLoreDirty = false;
            setTimeout(refreshUIAndPrompt, 200);
        });

        eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
            setTimeout(async () => {
                injectSceneButtons();
                await autoSaveIfDirty(false);
                const gmData = getChatGMData();
                if (gmData) await updatePromptInjection(gmData);
            }, 100);
        });

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            setTimeout(async () => {
                injectSceneButtons();
                await detectEventsOnTurn();
                await runBatchOrAutoSummary(false);
            }, 500);
        });

        console.log("[Genius Memory] 모듈 분리 버전(v0.2.0) 초기화 완료!");
    } catch (error) {
        console.error("[Genius Memory] 초기화 실패:", error);
    }
});