// ui.js - 사이드바 화면 렌더링, 하이라이트, 점선 표시 및 수정사항 자동 저장
import { extension_settings } from "../../../extensions.js";
import { saveChatConditional, setExtensionPrompt, extension_prompt_types } from "../../../../script.js";
import {
    extensionName,
    PROMPT_KEY,
    runtime,
    ensureSettings,
    getChatGMData,
    isRoomEnabled,
    unhideRangeAndDivider
} from "./state.js";
import { computeVector, injectMemoryPrompt } from "./api.js";

export function syncSidebarToViewport() {
    const sidebar = document.getElementById("gm-sidebar");
    if (!sidebar) return;
    if (window.visualViewport) {
        const vv = window.visualViewport;
        sidebar.style.top = `${vv.offsetTop}px`;
        sidebar.style.height = `${vv.height}px`;
    } else {
        sidebar.style.top = "0px";
        sidebar.style.height = "100dvh";
    }
}

export function loadSettingsUI() {
    const s = ensureSettings();
    $("#gm_enabled").prop("checked", s.enabled);
    $("#gm_api_url").val(s.api_url);
    $("#gm_api_key").val(s.api_key);
    $("#gm_model").val(s.model);
    $("#gm_chunk_size").val(s.chunk_size);
    $("#gm_buffer_size").val(s.buffer_size);
    $("#gm_consolidate_count").val(s.consolidate_count);
    $("#gm_recall_top_k").val(s.recall_top_k);
    $("#gm_embed_model").val(s.embed_model);
    $("#gm_auto_detect_events").prop("checked", s.auto_detect_events);
}

// 점 3개(...) 메뉴에 '<', '>' 버튼 주입 (클릭 시 실시간으로 부모 .mes의 mesid를 읽음)
export function injectSceneButtons() {
    $("#chat .mes").each(function () {
        if ($(this).find(".gm-scene-btn").length > 0) return;

        const btnHtml = `
            <div class="mes_button gm-scene-btn gm-set-start" title="GM: 여기부터 요약 시작">&lt;</div>
            <div class="mes_button gm-scene-btn gm-set-end" title="GM: 여기까지 요약 끝">&gt;</div>
        `;

        const extraMenu = $(this).find(".extraMesButtons");
        if (extraMenu.length > 0) {
            extraMenu.prepend(btnHtml);
        }
    });
}

export function updateRangeHighlight() {
    $("#chat .mes").removeClass("gm-range-start gm-range-end gm-in-range");

    const sIdx = runtime.selectedStartIdx;
    const eIdx = runtime.selectedEndIdx;

    if (sIdx !== null) {
        $("#gm-start-turn").val(sIdx);
        $(`#chat .mes[mesid="${sIdx}"]`).addClass("gm-range-start");
    } else {
        $("#gm-start-turn").val("");
    }

    if (eIdx !== null) {
        $("#gm-end-turn").val(eIdx);
        $(`#chat .mes[mesid="${eIdx}"]`).addClass("gm-range-end");
    } else {
        $("#gm-end-turn").val("");
    }

    if (sIdx !== null && eIdx !== null && sIdx <= eIdx) {
        for (let i = sIdx; i <= eIdx; i++) {
            $(`#chat .mes[mesid="${i}"]`).addClass("gm-in-range");
        }
        $("#gm-range-sum-btn").text(`🎯 ${sIdx}~${eIdx}턴 메인요약`);
        $("#gm-bookmark-text").text(`🎬 ${sIdx}~${eIdx}턴 메뉴`);
    } else {
        $("#gm-range-sum-btn").text(`🎯 구간 메인요약`);
        $("#gm-bookmark-text").text(`🎬 요약 메뉴`);
    }
}

export function clearRangeSelection() {
    runtime.selectedStartIdx = null;
    runtime.selectedEndIdx = null;
    updateRangeHighlight();
}

export function renderMacroChunkSlots(gmData) {
    const container = $("#gm-chunk-slots-container");
    if (container.length === 0) return;
    container.empty();

    const limit = Number(extension_settings[extensionName].consolidate_count) || 5;
    const chunks = gmData?.macro_chunks || [];

    for (let i = 0; i < limit; i++) {
        const chunk = chunks[i];
        const hasContent = chunk && chunk.content && chunk.content.trim().length > 0;
        const rangeLabel = hasContent && chunk.range ? `(${chunk.range})` : "(비어 있음)";
        const contentVal = hasContent ? chunk.content : "";
        const clearBtnHtml = hasContent
            ? `<span class="gm-clear-chunk-btn" data-idx="${i}" title="이 조각을 즉시 비우고 해당 턴의 숨김을 해제합니다.">🗑️ 비우기</span>`
            : "";

        container.append(`
            <div class="gm-fold-box gm-chunk-slot gm-collapsed" data-idx="${i}">
                <div class="gm-fold-header">
                    <span class="gm-chunk-title-text" style="color:${hasContent ? '#93c5fd' : '#777'};">
                        #${i + 1}번째 조각 ${rangeLabel}
                    </span>
                    <div style="display:flex; align-items:center; gap:6px;">
                        ${clearBtnHtml}
                        <i class="fa-solid fa-chevron-down gm-fold-icon"></i>
                    </div>
                </div>
                <div class="gm-fold-body">
                    <textarea class="gm-textarea gm-chunk-input" data-idx="${i}" data-range="${hasContent ? (chunk.range || "") : ""}" placeholder="${i + 1}번째 요약이 이곳에 기록됩니다.">${contentVal}</textarea>
                </div>
            </div>
        `);
    }
}

export function renderAllDividers(dividers = []) {
    $(".gm-summary-divider").remove();
    for (const info of dividers) {
        const targetMes = $(`#chat .mes[mesid="${info.mesId}"]`);
        if (targetMes.length > 0) {
            const dividerHtml = `
                <div class="gm-summary-divider" data-start="${info.startTurn}" data-end="${info.endTurn}" title="클릭하면 이 구간의 메시지 숨김(유령) 처리를 해제합니다.">
                    <span>⚡ GM: ${info.startTurn} ~ ${info.endTurn}턴 요약됨 (클릭 시 숨김 해제)</span>
                </div>`;
            targetMes.after(dividerHtml);
        }
    }
}

export function renderLorebookList(gmData) {
    const ongoingEl = $("#gm-ongoing-list");
    if (ongoingEl.length > 0) {
        ongoingEl.empty();
        const ongoing = gmData?.ongoing_events || [];
        if (ongoing.length === 0) {
            ongoingEl.html(`<div style="color:#777; font-size:0.76em; padding:4px 0;">현재 감지된 진행 중 사건이 없습니다.</div>`);
        } else {
            ongoing.forEach((ev, idx) => {
                ongoingEl.append(`
                    <div class="gm-ongoing-card" data-idx="${idx}">
                        <div class="gm-ongoing-info">
                            <span class="gm-pulse-dot"></span>
                            <span>[${ev.title}] (${ev.startTurn}턴~ 진행 중)</span>
                        </div>
                        <div class="gm-ongoing-actions">
                            <span class="gm-finish-event-btn" data-idx="${idx}" title="지금 턴을 끝으로 이 사건을 요약하여 완료 로어북으로 넘깁니다.">✅ 지금 완료</span>
                            <span class="gm-ongoing-del" data-idx="${idx}" style="cursor:pointer; color:#f87171; padding:0 4px;" title="진행 취소/삭제"><i class="fa-solid fa-xmark"></i></span>
                        </div>
                    </div>
                `);
            });
        }
    }

    const listEl = $("#gm-lore-list");
    if (listEl.length === 0) return;
    listEl.empty();

    const events = gmData?.micro_events || [];
    $("#gm-lore-count").text(`(${events.length})`);

    if (events.length === 0) {
        listEl.html(`<div style="text-align:center; color:#777; padding:15px 0; font-size:0.8em;">완료된 사건 로어북이 없습니다.</div>`);
        return;
    }

    events.forEach((ev, idx) => {
        const titleStr = ev.title ? `[${ev.title}]` : (ev.keys?.[0] ? `[${ev.keys[0]}]` : "[사건 기록]");
        const keysStr = (ev.keys || []).join(", ");
        const isRecalled = ev._recalled ? "gm-recalled" : "";
        const scoreText = ev._lastScore !== undefined ? `${ev._lastScore}` : "완료";
        const badgeText = ev._recalled ? `🔥 호출됨 (${scoreText})` : `🟢 대기 (${scoreText})`;
        const collapsedClass = ev.content ? "gm-collapsed" : "";
        const startDisp = ev.startTurn !== undefined ? ev.startTurn : "?";
        const endDisp = ev.endTurn !== undefined ? ev.endTurn : "?";

        const cardHtml = `
            <div class="gm-fold-box gm-lore-card ${isRecalled} ${collapsedClass}" data-idx="${idx}">
                <div class="gm-fold-header">
                    <span style="color:#93c5fd;">#${idx + 1} (${startDisp}~${endDisp}턴) <b style="color:#fcd34d;">${titleStr}</b></span>
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span class="gm-lore-badge">${badgeText}</span>
                        <span class="gm-lore-del" data-idx="${idx}" title="이 사건 삭제"><i class="fa-solid fa-trash-can"></i></span>
                        <i class="fa-solid fa-chevron-down gm-fold-icon"></i>
                    </div>
                </div>
                <div class="gm-fold-body">
                    <input type="text" class="gm-lore-title gm-lore-keys" style="color:#93c5fd !important; margin-bottom:2px;" value="${(ev.title || "").replace(/"/g, '&quot;')}" placeholder="사건 제목 (예: 점심 식사)" />
                    <input type="text" class="gm-lore-keys gm-lore-keys-only" value="${keysStr.replace(/"/g, '&quot;')}" placeholder="로어북 호출 키워드 (쉼표로 구분)" />
                    <textarea class="gm-lore-content gm-textarea" placeholder="상세 사건 기록...">${ev.content || ""}</textarea>
                </div>
            </div>
        `;
        listEl.append(cardHtml);
    });
}

export async function updatePromptInjection(gmData) {
    await injectMemoryPrompt(gmData);
    if (gmData) renderLorebookList(gmData);
}

export async function refreshUIAndPrompt() {
    const gmData = getChatGMData();
    const s = extension_settings[extensionName];

    injectSceneButtons();

    if (!gmData) {
        $("#gm-macro-summary, #gm-state-tracker, #gm-open-tracker, #gm-items-tracker").val("");
        $("#gm-chunk-counter").text(`(조각: 0/${s.consolidate_count})`);
        $("#gm-chunk-slots-container, #gm-ongoing-list, #gm-lore-list").empty();
        $("#gm-lore-count").text("(0)");
        setExtensionPrompt(PROMPT_KEY, "", extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const roomOn = isRoomEnabled();
    $("#gm_enabled").prop("checked", roomOn);
    $("#gm-room-toggle-btn")
        .removeClass("gm-room-on gm-room-off")
        .addClass(roomOn ? "gm-room-on" : "gm-room-off")
        .html(roomOn ? "<span>🟢 ON</span>" : "<span>⚪ OFF</span>");

    $("#gm-macro-summary").val(gmData.macro_summary);
    $("#gm-state-tracker").val(gmData.state);
    $("#gm-open-tracker").val(gmData.open);
    $("#gm-items-tracker").val(gmData.items);
    $("#gm-chunk-counter").text(`(조각: ${gmData.macro_chunks.length}/${s.consolidate_count})`);

    renderMacroChunkSlots(gmData);
    renderAllDividers(gmData.dividers);
    await updatePromptInjection(gmData);
}

export async function autoSaveIfDirty(showToast = true) {
    if (!runtime.isStateDirty && !runtime.isLoreDirty) return;
    const gmData = getChatGMData();
    if (!gmData) return;

    if (runtime.isStateDirty) {
        gmData.macro_summary = $("#gm-macro-summary").val();
        const oldRanges = (gmData.macro_chunks || []).map(c => c.range).filter(Boolean);
        const newChunks = [];

        $(".gm-chunk-input").each(function () {
            const val = $(this).val().trim();
            const range = $(this).attr("data-range") || "수동 입력";
            if (val.length > 0) {
                newChunks.push({ range, content: val });
            }
        });

        const remainingRanges = new Set(newChunks.map(c => c.range));
        for (const oldR of oldRanges) {
            if (!remainingRanges.has(oldR)) {
                unhideRangeAndDivider(gmData, oldR);
            }
        }

        gmData.macro_chunks = newChunks;
        gmData.state = $("#gm-state-tracker").val();
        gmData.open = $("#gm-open-tracker").val();
        gmData.items = $("#gm-items-tracker").val();
        runtime.isStateDirty = false;
        $("#gm-rollback-state-btn").removeClass("gm-has-unsaved");

        const s = extension_settings[extensionName];
        $("#gm-chunk-counter").text(`(조각: ${gmData.macro_chunks.length}/${s.consolidate_count})`);
        renderMacroChunkSlots(gmData);
        renderAllDividers(gmData.dividers);
    }

    if (runtime.isLoreDirty) {
        const cards = $(".gm-lore-card");
        for (let i = 0; i < cards.length; i++) {
            const card = $(cards[i]);
            const idx = Number(card.attr("data-idx"));
            if (!gmData.micro_events[idx]) continue;

            const titleStr = card.find(".gm-lore-title").val() || "";
            const keysStr = card.find(".gm-lore-keys-only").val() || "";
            const contentStr = card.find(".gm-lore-content").val() || "";

            gmData.micro_events[idx].title = titleStr.trim();
            gmData.micro_events[idx].keys = keysStr.split(",").map(k => k.trim()).filter(Boolean);
            gmData.micro_events[idx].content = contentStr.trim();
            gmData.micro_events[idx].vector = await computeVector(`${titleStr} ${keysStr} ${contentStr}`);
        }
        runtime.isLoreDirty = false;
        $("#gm-rollback-lore-btn").removeClass("gm-has-unsaved");
    }

    await saveChatConditional();
    await updatePromptInjection(gmData);
    if (showToast) {
        toastr.success("수정한 기억이 자동 저장되었습니다.", "🧠 Genius Memory", { timeOut: 1500 });
    }
}