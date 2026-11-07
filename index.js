import { extension_settings, getContext } from "../../../extensions.js";
import { 
    saveSettingsDebounced, 
    eventSource, 
    event_types, 
    saveChatConditional, 
    setExtensionPrompt, 
    extension_prompt_types 
} from "../../../../script.js";

const extensionName = "genius-memory";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const PROMPT_KEY = "genius_memory_context";

// 기본 설정값
const defaultSettings = {
    enabled: true,
    api_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key: "",
    model: "gemini-1.5-flash",
    chunk_size: 10,
    buffer_size: 2,
    consolidate_count: 5,
    recall_top_k: 3,
    embed_model: "",
    auto_detect_events: true
};

let isSummarizing = false;
let isDetectingEvent = false;
let isDeletingLore = false;
let selectedStartIdx = null; // 0-based index
let selectedEndIdx = null;   // 0-based index
let isStateDirty = false;    // 메인 상태창 수정 여부
let isLoreDirty = false;     // 사건 로어북 수정 여부

// 🌟 1. 메인 상태창 요약 프롬프트 (실제 등장인물 이름 강제, 다인 시뮬레이션 지원)
const SUMMARY_SYSTEM_PROMPT = `Role: Narrative State Analyst. Condense RP context into a dense, high-retention log. Preserve pivotal details while aggressively stripping prose and fluff.

[WHAT TO DROP (Fluff)]
- Atmospheric descriptions, sensory details, casual banter, greetings, repetitive actions.
- Neutralize NSFW/intimacy into dry clinical facts (e.g., "Engaged in intercourse").

[WHAT TO RETAIN (Core Anchors)]
- Exact proper nouns, character names, locations, times, numerical values, and items.
- Causal logic: Intent -> Action -> Consequence/Cost.
- Crucial verbatim quotes in "" ONLY if they define a major choice, threat, or turning point.

[RULES]
1. Syntax: Telegraphic logbook style. No flowery prose. Use noun/verb fragments or arrows (->).
2. Density: High information density. Keep bullets substantive.
3. Names: NEVER output literal "{{char}}" or "{{user}}". ALWAYS use the actual names of every character and participant appearing in the dialogue (supports multi-character / group RP).
4. Trajectory: Map psyche/relation shifts for each relevant character as [Name]: [Prior] -> [Trigger] -> [Current].
5. Language: Output in the SAME language as the provided RP dialogue (if Korean RP, output in Korean).
6. Boundary: Output ONLY the format below. No markdown fences or commentary.

[FORMAT]
[ACT]
- [Time/Place] [Context]: [Actual Actor Name] -> [Specific action/decision + intent] -> [Outcome/Cost]
- (Repeat for 3–6 key chronological events)

[STATE]
- [Character/User Actual Name]: [Prior psyche] -> [Trigger/Realization] -> [Current state & motive]
- (Repeat a bullet for EACH active character in the scene)
- Dynamic: [Names involved] [Prior dynamic] -> [Shift event] -> [Current dynamic]

[OPEN]
- [Unresolved danger, promise, pending decision, or secret separated by " · "]

[ITEMS]
- [Owner Name]: [Notable inventory reflecting acquisitions, uses, or losses]`;

// 🌟 2. 5개 조각 누적 시 [통합 전체 요약]으로 합치는 프롬프트
const CONSOLIDATE_SYSTEM_PROMPT = `Role: Master Narrative Archivist.
Condense the provided multiple [ACT] logs into a single, cohesive, chronological master summary log.
- Retain core plot progression, major turning points, key proper nouns, actual character names, and permanent consequences.
- Merge or drop minor intermediate steps that are already resolved.
- Keep the telegraphic arrow (->) logbook style.
- Output in the SAME language as the input logs. Output ONLY the bulleted list without any headers or markdown fences.`;

// 🌟 3. 매 턴 돌아가는 다중/교차 사건 시작·종료 감지기 프롬프트
const EVENT_DETECTOR_PROMPT = `Role: Multi-Thread Narrative Event Detector.
In complex RP or multi-character simulations, MULTIPLE events can happen simultaneously or overlap across turns.
Analyze the recent RP turns and [Currently Ongoing Events].

1. Check if ANY of the [Currently Ongoing Events] have concluded or resolved. (You may output multiple END lines if multiple events ended).
2. Check if one or more NEW notable events/subplots have started, even if another event is still ongoing. Do NOT duplicate events already listed in [Currently Ongoing Events].

Output ONLY using one or more lines in this exact format (in the same language as the dialogue, or write NONE):
END: [Exact Title from Ongoing Events, or NONE] | [End Turn Number]
START: [Short Title of new event (2~5 words), or NONE] | [Start Turn Number]`;

// 🌟 4. 사건 로어북 전용: 제스처, 핵심 대사(""), 감정선, 세부 행동을 보존하는 정밀 기록 프롬프트
const LORE_EVENT_SYSTEM_PROMPT = `Role: High-Detail Episodic Memory Archivist.
Unlike a dry macro summary, this Lorebook entry is recalled ONLY when this specific past event is referenced. Preserve VIVID EPISODIC DETAILS in a compact, structured format so the AI can recall the exact mood, gestures, quotes, and emotions of the scene.

[WHAT TO CAPTURE]
1. Micro-Actions & Gestures: Specific facial expressions, gaze, body language, physical contact, and small meaningful actions.
2. Verbatim Quotes ("..."): Preserve 2–5 memorable or pivotal lines of dialogue word-for-word to retain tone, nuance, and speech style.
3. Emotional Subtext: Each character's shifting feelings, vocal tone, and internal reactions.
4. Concrete Details: Specific objects, food/drinks, attire, environment details, or promises made.
5. Thread Focus: Focus on [Target Event Hint] and ignore unrelated parallel subplots.

[RULES]
- NEVER use "{{char}}" or "{{user}}". ALWAYS use actual character names.
- Be concise and dense (no flowery filler), using structured bullets and arrows (->), but NEVER strip away emotional or behavioral specifics.
- Output in the SAME language as the dialogue (if Korean RP, output in Korean). Output ONLY the format below.

[FORMAT]
[TITLE]
- [Short specific title of the event]

[KEYS]
- [5 to 8 comma-separated trigger keywords: character names, location, specific objects, key theme]

[CONTENT]
- [배경/분위기]: [Time/Place, atmosphere, initial situation]
- [상세 전개]:
  • [Name] ([Expression/Gesture/Tone]) -> [Specific action or physical detail] : "[Exact memorable quote]" -> [Other character's emotional/behavioral reaction]
  • (Repeat 4–8 detailed chronological beats covering the beginning, climax, and resolution of the scene)
- [결과/여운]: [How the scene ended, emotional aftermath, relationship shift, or concrete outcome]`;

// 설정 불러오기
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
    const s = extension_settings[extensionName];
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

// 현재 채팅방의 GM 데이터 가져오기
function getChatGMData() {
    const context = getContext();
    if (!context || !context.chatMetadata) return null;

    if (!context.chatMetadata.genius_memory) {
        context.chatMetadata.genius_memory = {
            macro_summary: "",
            macro_chunks: [],
            state: "",
            open: "",
            items: "",
            dividers: [],
            ongoing_events: [],
            micro_events: []
        };
    }
    const gm = context.chatMetadata.genius_memory;
    gm.macro_summary = gm.macro_summary || "";
    gm.macro_chunks = gm.macro_chunks || [];
    gm.state = gm.state || "";
    gm.open = gm.open || "";
    gm.items = gm.items || "";
    gm.dividers = gm.dividers || [];
    gm.ongoing_events = gm.ongoing_events || [];
    gm.micro_events = gm.micro_events || [];
    return gm;
}

// 각 메시지의 점 3개(...) 메뉴 안에 '<' 칸과 '>' 칸 주입
function injectSceneButtons() {
    $("#chat .mes").each(function () {
        if ($(this).find(".gm-scene-btn").length > 0) return;
        const mesId = Number($(this).attr("mesid"));

        const btnHtml = `
            <div class="mes_button gm-scene-btn gm-set-start" data-mesid="${mesId}" title="GM: 여기부터 요약 시작 (${mesId + 1}턴)">&lt;</div>
            <div class="mes_button gm-scene-btn gm-set-end" data-mesid="${mesId}" title="GM: 여기까지 요약 끝 (${mesId + 1}턴)">&gt;</div>
        `;

        const extraMenu = $(this).find(".extraMesButtons");
        if (extraMenu.length > 0) {
            extraMenu.prepend(btnHtml);
        }
    });
}

// 선택한 구간 하이라이트 및 책갈피/입력창 동기화
function updateRangeHighlight() {
    $("#chat .mes").removeClass("gm-range-start gm-range-end gm-in-range");

    if (selectedStartIdx !== null) {
        $("#gm-start-turn").val(selectedStartIdx + 1);
        $(`#chat .mes[mesid="${selectedStartIdx}"]`).addClass("gm-range-start");
    } else {
        $("#gm-start-turn").val("");
    }

    if (selectedEndIdx !== null) {
        $("#gm-end-turn").val(selectedEndIdx + 1);
        $(`#chat .mes[mesid="${selectedEndIdx}"]`).addClass("gm-range-end");
    } else {
        $("#gm-end-turn").val("");
    }

    if (selectedStartIdx !== null && selectedEndIdx !== null && selectedStartIdx <= selectedEndIdx) {
        for (let i = selectedStartIdx; i <= selectedEndIdx; i++) {
            $(`#chat .mes[mesid="${i}"]`).addClass("gm-in-range");
        }
        $("#gm-range-sum-btn").text(`🎯 ${selectedStartIdx + 1}~${selectedEndIdx + 1}턴 메인요약`);
        $("#gm-bookmark-text").text(`🎬 ${selectedStartIdx + 1}~${selectedEndIdx + 1}턴 메뉴`);
    } else {
        $("#gm-range-sum-btn").text(`🎯 구간 메인요약`);
        $("#gm-bookmark-text").text(`🎬 요약 메뉴`);
    }
}

function clearRangeSelection() {
    selectedStartIdx = null;
    selectedEndIdx = null;
    updateRangeHighlight();
}

// 1~5번째 요약 조각 슬롯 렌더링
function renderMacroChunkSlots(gmData) {
    const container = $("#gm-chunk-slots-container");
    if (container.length === 0) return;
    container.empty();

    const limit = Number(extension_settings[extensionName].consolidate_count) || 5;
    const chunks = gmData?.macro_chunks || [];

    for (let i = 0; i < limit; i++) {
        const chunk = chunks[i];
        const rangeLabel = chunk ? `(${chunk.range})` : "(비어 있음)";
        const contentVal = chunk ? chunk.content : "";
        container.append(`
            <div class="gm-chunk-slot">
                <div class="gm-chunk-label">
                    <span>#${i + 1}번째 요약 조각 ${rangeLabel}</span>
                </div>
                <textarea class="gm-textarea gm-chunk-input" data-idx="${i}" data-range="${chunk?.range || ""}" style="min-height:52px;" placeholder="${i + 1}번째 요약이 이곳에 기록됩니다.">${contentVal}</textarea>
            </div>
        `);
    }
}

// 채팅창에 [요약됨] 하얀 점선 표시
function renderAllDividers(dividers = []) {
    $(".gm-summary-divider").remove();
    for (const info of dividers) {
        const targetMes = $(`#chat .mes[mesid="${info.mesId}"]`);
        if (targetMes.length > 0) {
            const dividerHtml = `
                <div class="gm-summary-divider" data-start="${info.startTurn - 1}" data-end="${info.endTurn - 1}" title="클릭하면 이 구간의 메시지 숨김(유령) 처리를 해제합니다.">
                    <span>⚡ GM: ${info.startTurn} ~ ${info.endTurn}턴 요약됨 (클릭 시 숨김 해제)</span>
                </div>`;
            targetMes.after(dividerHtml);
        }
    }
}

// 서브 API 호출
async function callSubAPI(systemPrompt, userText) {
    const s = extension_settings[extensionName];
    if (!s.api_url || !s.api_key || !s.model) {
        throw new Error("서브 API 설정(URL, Key, Model)이 비어있습니다. 확장 프로그램 설정을 확인해주세요.");
    }

    const baseUrl = s.api_url.replace(/\/+$/, "");
    const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${s.api_key}`
        },
        body: JSON.stringify({
            model: s.model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userText }
            ],
            temperature: 0.2
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 오류 (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
}

// 텍스트 벡터화 (API 임베딩 또는 내장 256차원 로컬 바이그램 벡터)
async function computeVector(text) {
    const s = extension_settings[extensionName];
    const clean = (text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    if (!clean) return [];

    if (s.embed_model && s.api_url && s.api_key) {
        try {
            const baseUrl = s.api_url.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
            const res = await fetch(`${baseUrl}/embeddings`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${s.api_key}`
                },
                body: JSON.stringify({ model: s.embed_model, input: clean })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.data?.[0]?.embedding) return data.data[0].embedding;
            }
        } catch (e) {
            console.warn("[GM] 임베딩 API 호출 실패, 내장 로컬 벡터로 전환합니다:", e);
        }
    }

    const DIM = 256;
    const vec = new Array(DIM).fill(0);
    const compressed = clean.replace(/\s+/g, "");
    for (let i = 0; i < compressed.length - 1; i++) {
        const bg = compressed.slice(i, i + 2);
        let h = 2166136261;
        for (let j = 0; j < bg.length; j++) {
            h ^= bg.charCodeAt(j);
            h = Math.imul(h, 16777619);
        }
        vec[Math.abs(h) % DIM] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map(v => Number((v / norm).toFixed(4)));
}

// 코사인 유사도 계산
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return (normA && normB) ? (dot / (Math.sqrt(normA) * Math.sqrt(normB))) : 0;
}

// 로어북 키워드 + 벡터 유사도 하이브리드 검색
async function retrieveRelevantEvents(gmData) {
    const events = gmData?.micro_events || [];
    if (events.length === 0) return [];

    const context = getContext();
    const chat = context?.chat || [];
    const recentText = chat.slice(-4).map(m => m.mes || "").join(" ").toLowerCase();
    if (!recentText.trim()) return [];

    const queryVec = await computeVector(recentText);
    const topK = Number(extension_settings[extensionName].recall_top_k) || 3;

    const scored = [];
    for (let idx = 0; idx < events.length; idx++) {
        const ev = events[idx];
        ev.keys = Array.isArray(ev.keys) ? ev.keys : [];
        if (!ev.vector || ev.vector.length === 0) {
            ev.vector = await computeVector(`${ev.title || ""} ${ev.keys.join(" ")} ${ev.content || ""}`);
        }

        let matchedKeys = 0;
        for (const k of ev.keys) {
            if (k && recentText.includes(k.toLowerCase())) matchedKeys++;
        }
        if (ev.title && recentText.includes(ev.title.toLowerCase())) {
            matchedKeys++;
        }

        const keywordBonus = matchedKeys > 0 ? Math.min(0.6, matchedKeys * 0.25) : 0;
        const vecScore = cosineSimilarity(queryVec, ev.vector);
        const totalScore = Number((vecScore + keywordBonus).toFixed(3));

        ev._lastScore = totalScore;
        ev._recalled = false;
        scored.push({ ev, idx, totalScore });
    }

    const selected = scored
        .filter(item => item.totalScore >= 0.15)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, topK);

    selected.forEach(item => { item.ev._recalled = true; });
    return selected.sort((a, b) => a.idx - b.idx).map(item => item.ev);
}

// 사이드바 [사건 로어북] 탭 ([기록 중] + [완료]) 렌더링
function renderLorebookList(gmData) {
    // 1. [⏳ 기록 중] 진행 사건 렌더링
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

    // 2. [✅ 완료된 사건] 로어북 렌더링
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

        const cardHtml = `
            <div class="gm-fold-box gm-lore-card ${isRecalled} ${collapsedClass}" data-idx="${idx}">
                <div class="gm-fold-header">
                    <span style="color:#93c5fd;">#${idx + 1} (${ev.startTurn || "?"}~${ev.endTurn || "?"}턴) <b style="color:#fcd34d;">${titleStr}</b></span>
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

// 프롬프트 주입 (통합 요약 + 1~5 조각 + 로어북/벡터 검색된 과거 사건 + 상태창)
async function updatePromptInjection(gmData) {
    if (!extension_settings[extensionName].enabled || !gmData) {
        if (gmData) renderLorebookList(gmData);
        setExtensionPrompt(PROMPT_KEY, "", extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const recalledEvents = await retrieveRelevantEvents(gmData);
    renderLorebookList(gmData);

    let parts = [];
    let fullMacro = [];
    if (gmData.macro_summary.trim()) fullMacro.push(gmData.macro_summary.trim());
    for (const c of (gmData.macro_chunks || [])) {
        if (c.content && c.content.trim()) fullMacro.push(`[Turns ${c.range}]\n${c.content.trim()}`);
    }
    if (fullMacro.length > 0) {
        parts.push(`[Story Summary So Far]\n${fullMacro.join("\n\n")}`);
    }

    if (recalledEvents.length > 0) {
        const recalledText = recalledEvents
            .map(ev => `• [${ev.title || "Event"} | Turns ${ev.startTurn}~${ev.endTurn} | Keys: ${(ev.keys || []).join(", ")}]\n${ev.content}`)
            .join("\n\n");
        parts.push(`[Recalled Detailed Past Events (Lorebook & Vector RAG)]\n${recalledText}`);
    }

    if (gmData.state.trim()) parts.push(`[Current Character & Relationship State]\n${gmData.state.trim()}`);
    if (gmData.open.trim()) parts.push(`[Active Promises & Unresolved Plots]\n${gmData.open.trim()}`);
    if (gmData.items.trim()) parts.push(`[Current Inventory]\n${gmData.items.trim()}`);

    if (parts.length === 0) {
        setExtensionPrompt(PROMPT_KEY, "", extension_prompt_types.BEFORE_PROMPT, 0);
        return;
    }

    const finalPrompt = `<genius_memory_context>\n${parts.join("\n\n")}\n</genius_memory_context>`;
    setExtensionPrompt(PROMPT_KEY, finalPrompt, extension_prompt_types.BEFORE_PROMPT, 0);
}

// UI 및 프롬프트 전체 새로고침
async function refreshUIAndPrompt() {
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

    $("#gm-macro-summary").val(gmData.macro_summary);
    $("#gm-state-tracker").val(gmData.state);
    $("#gm-open-tracker").val(gmData.open);
    $("#gm-items-tracker").val(gmData.items);
    $("#gm-chunk-counter").text(`(조각: ${gmData.macro_chunks.length}/${s.consolidate_count})`);

    renderMacroChunkSlots(gmData);
    renderAllDividers(gmData.dividers);
    await updatePromptInjection(gmData);
}

// 플레이어가 수정한 내용이 있으면 창을 닫거나 다음 인풋 전송 시 자동 저장
async function autoSaveIfDirty(showToast = true) {
    if (!isStateDirty && !isLoreDirty) return;
    const gmData = getChatGMData();
    if (!gmData) return;

    if (isStateDirty) {
        gmData.macro_summary = $("#gm-macro-summary").val();
        const newChunks = [];
        $(".gm-chunk-input").each(function () {
            const val = $(this).val().trim();
            const range = $(this).attr("data-range") || "수동 입력";
            if (val) newChunks.push({ range, content: val });
        });
        gmData.macro_chunks = newChunks;
        gmData.state = $("#gm-state-tracker").val();
        gmData.open = $("#gm-open-tracker").val();
        gmData.items = $("#gm-items-tracker").val();
        isStateDirty = false;
        $("#gm-rollback-state-btn").removeClass("gm-has-unsaved");
    }

    if (isLoreDirty) {
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
        isLoreDirty = false;
        $("#gm-rollback-lore-btn").removeClass("gm-has-unsaved");
    }

    await saveChatConditional();
    await updatePromptInjection(gmData);
    if (showToast) {
        toastr.success("수정한 기억이 자동 저장되었습니다.", "🧠 Genius Memory", { timeOut: 1500 });
    }
}

// AI 메인 요약 출력 파싱
function parseSummaryOutput(text) {
    const actMatch = text.match(/\[ACT\]\s*([\s\S]*?)(?=\[STATE\]|\[OPEN\]|\[ITEMS\]|\[KEYS\]|$)/i);
    const stateMatch = text.match(/\[STATE\]\s*([\s\S]*?)(?=\[OPEN\]|\[ITEMS\]|\[KEYS\]|$)/i);
    const openMatch = text.match(/\[OPEN\]\s*([\s\S]*?)(?=\[ITEMS\]|\[KEYS\]|$)/i);
    const itemsMatch = text.match(/\[ITEMS\]\s*([\s\S]*?)(?=\[KEYS\]|$)/i);

    return {
        act: actMatch ? actMatch[1].trim() : "",
        state: stateMatch ? stateMatch[1].trim() : "",
        open: openMatch ? openMatch[1].trim() : "",
        items: itemsMatch ? itemsMatch[1].trim() : ""
    };
}

// 메시지 숨김(유령) 처리 및 해제
function setMessagesHidden(chat, indices, hidden = true) {
    for (const i of indices) {
        if (chat[i]) {
            chat[i].is_system = hidden;
            $(`#chat .mes[mesid="${i}"]`).attr("is_system", hidden ? "true" : "false");
        }
    }
}

// 쌓인 조각들을 [통합 전체 요약]으로 압축 후 슬롯 비우기
async function consolidateChunksToMaster(gmData) {
    if (!gmData.macro_chunks || gmData.macro_chunks.length === 0) return;
    toastr.info(`요약 조각 ${gmData.macro_chunks.length}개를 [통합 전체 요약]으로 합치는 중...`, "🧠 Genius Memory");

    const combinedInput = [
        gmData.macro_summary ? `[Prior Master Summary]\n${gmData.macro_summary}` : "",
        ...gmData.macro_chunks.map((c, i) => `[Chunk #${i + 1} (${c.range})]\n${c.content}`)
    ].filter(Boolean).join("\n\n");

    const consolidated = await callSubAPI(CONSOLIDATE_SYSTEM_PROMPT, combinedInput);
    if (consolidated.trim()) {
        gmData.macro_summary = consolidated.trim();
        gmData.macro_chunks = [];
    }
}

// 지정된 메시지 인덱스 배열을 메인 상태창으로 요약 실행
async function executeSummaryForIndices(indicesToSummarize) {
    const context = getContext();
    const chat = context.chat;
    const gmData = getChatGMData();
    const s = extension_settings[extensionName];

    const startIdx = indicesToSummarize[0];
    const endIdx = indicesToSummarize[indicesToSummarize.length - 1];
    const rangeStr = `${startIdx + 1}~${endIdx + 1}턴`;

    toastr.info(`${rangeStr} 메인 상태창 요약을 진행합니다...`, "🧠 Genius Memory");

    const userName = context.name1 || "User";
    const charName = context.name2 || "Character";

    const dialogueLines = indicesToSummarize.map(idx => {
        const m = chat[idx];
        return `[Turn ${idx + 1}] ${m.name}: ${m.mes}`;
    }).join("\n\n");

    const userPrompt = `[Participants Info]
User Persona Name: ${userName}
Main Character / Group Name: ${charName} (Note: Use actual speaker names from the dialogue below)

[Prior State Context]
STATE:
${gmData.state || "None"}

OPEN:
${gmData.open || "None"}

ITEMS:
${gmData.items || "None"}

[Dialogue to Analyze (Turns ${startIdx + 1} to ${endIdx + 1})]
${dialogueLines}`;

    const rawOutput = await callSubAPI(SUMMARY_SYSTEM_PROMPT, userPrompt);
    const parsed = parseSummaryOutput(rawOutput);

    if (!parsed.act && !parsed.state) {
        throw new Error("AI 응답 형식이 올바르지 않습니다: " + rawOutput.slice(0, 100));
    }

    if (parsed.act) {
        gmData.macro_chunks.push({
            range: rangeStr,
            content: parsed.act
        });
    }
    if (parsed.state) gmData.state = parsed.state;
    if (parsed.open) gmData.open = parsed.open;
    if (parsed.items) gmData.items = parsed.items;

    const consolidateLimit = Number(s.consolidate_count) || 5;
    if (gmData.macro_chunks.length >= consolidateLimit) {
        await consolidateChunksToMaster(gmData);
    }

    setMessagesHidden(chat, indicesToSummarize, true);

    gmData.dividers = gmData.dividers.filter(d => d.mesId !== endIdx);
    gmData.dividers.push({
        mesId: endIdx,
        startTurn: startIdx + 1,
        endTurn: endIdx + 1
    });

    await saveChatConditional();
    await refreshUIAndPrompt();
}

// 특정 턴 구간(startTurn ~ endTurn)을 숨김 여부와 상관없이 긁어와 [완료된 사건 로어북]으로 정밀 기록
async function summarizeLoreEventRange(eventTitle, startTurn, endTurn) {
    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || chat.length === 0) return;

    const sIdx = Math.max(0, Number(startTurn) - 1);
    const eIdx = Math.min(chat.length - 1, Number(endTurn) - 1);
    if (sIdx > eIdx) return;

    toastr.info(`📚 사건 [${eventTitle || "선택 구간"}] (${sIdx + 1}~${eIdx + 1}턴) 정밀 로어북을 생성합니다...`, "🧠 Genius Memory");

    const lines = [];
    for (let i = sIdx; i <= eIdx; i++) {
        if (chat[i] && !chat[i].extra?.isSmallSys) {
            lines.push(`[Turn ${i + 1}] ${chat[i].name}: ${chat[i].mes}`);
        }
    }
    if (lines.length === 0) return;

    const userPrompt = `[Target Event Hint]: ${eventTitle || "Scene Event"} (Turns ${sIdx + 1} to ${eIdx + 1})\n\n[Dialogue]\n${lines.join("\n\n")}`;
    const raw = await callSubAPI(LORE_EVENT_SYSTEM_PROMPT, userPrompt);

    const titleMatch = raw.match(/\[TITLE\]\s*([\s\S]*?)(?=\[KEYS\]|\[CONTENT\]|$)/i);
    const keysMatch = raw.match(/\[KEYS\]\s*([\s\S]*?)(?=\[CONTENT\]|$)/i);
    const contentMatch = raw.match(/\[CONTENT\]\s*([\s\S]*?)$/i);

    const finalTitle = (titleMatch ? titleMatch[1].replace(/^-\s*/, "").trim() : "") || eventTitle || `${sIdx + 1}~${eIdx + 1}턴 사건`;
    const rawKeys = keysMatch ? keysMatch[1].replace(/^-\s*/, "").trim() : "";
    const keysArray = rawKeys.split(/[,·\n]/).map(k => k.trim().replace(/^-\s*/, "")).filter(Boolean);
    const finalContent = (contentMatch ? contentMatch[1].trim() : raw.trim());

    const vec = await computeVector(`${finalTitle} ${keysArray.join(" ")} ${finalContent}`);
    gmData.micro_events.push({
        title: finalTitle,
        startTurn: sIdx + 1,
        endTurn: eIdx + 1,
        keys: keysArray,
        content: finalContent,
        vector: vec
    });

    await saveChatConditional();
    await refreshUIAndPrompt();
    toastr.success(`✅ 사건 [${finalTitle}] (${sIdx + 1}~${eIdx + 1}턴) 로어북 기록 완료!`, "🧠 Genius Memory");
}

// 매 턴 돌아가는 다중/교차 사건 시작·종료 감지기
async function detectEventsOnTurn() {
    const s = extension_settings[extensionName];
    if (!s.enabled || !s.auto_detect_events || isDetectingEvent) return;

    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || chat.length < 2) return;

    isDetectingEvent = true;
    try {
        const totalTurns = chat.length;
        const startLookback = Math.max(0, totalTurns - 3);
        const recentLines = [];
        for (let i = startLookback; i < totalTurns; i++) {
            recentLines.push(`[Turn ${i + 1}] ${chat[i].name}: ${chat[i].mes}`);
        }

        const ongoingListStr = gmData.ongoing_events.length > 0
            ? gmData.ongoing_events.map(e => `- "${e.title}" (Started at Turn ${e.startTurn})`).join("\n")
            : "None";

        const detectorInput = `[Currently Ongoing Events]\n${ongoingListStr}\n\n[Recent Dialogue (Up to Turn ${totalTurns})]\n${recentLines.join("\n\n")}`;
        const result = await callSubAPI(EVENT_DETECTOR_PROMPT, detectorInput);

        let changed = false;

        // 1) 종료된 사건 감지 (다중 종료 지원)
        const endMatches = [...result.matchAll(/END:\s*([^|\n]+)\|\s*(\d+)/gi)];
        for (const match of endMatches) {
            const endedTitle = match[1].trim().replace(/^["']|["']$/g, "");
            const endTurnNum = Number(match[2]) || totalTurns;

            if (endedTitle.toUpperCase() !== "NONE" && gmData.ongoing_events.length > 0) {
                const targetIdx = gmData.ongoing_events.findIndex(e => 
                    endedTitle.toLowerCase().includes(e.title.toLowerCase()) || 
                    e.title.toLowerCase().includes(endedTitle.toLowerCase())
                );
                if (targetIdx !== -1) {
                    const targetEvent = gmData.ongoing_events.splice(targetIdx, 1)[0];
                    changed = true;
                    await summarizeLoreEventRange(
                        targetEvent.title, 
                        targetEvent.startTurn, 
                        Math.max(targetEvent.startTurn, endTurnNum)
                    );
                }
            }
        }

        // 2) 새로운 사건 시작 감지 (다중 시작 & 병렬 진행 지원)
        const startMatches = [...result.matchAll(/START:\s*([^|\n]+)\|\s*(\d+)/gi)];
        for (const match of startMatches) {
            const newTitle = match[1].trim().replace(/^["']|["']$/g, "");
            const startTurnNum = Number(match[2]) || totalTurns;

            if (
                newTitle.toUpperCase() !== "NONE" && 
                !gmData.ongoing_events.some(e => e.title.toLowerCase() === newTitle.toLowerCase())
            ) {
                gmData.ongoing_events.push({
                    title: newTitle,
                    startTurn: startTurnNum
                });
                changed = true;
                toastr.info(`⏳ 새 사건 감지됨: [${newTitle}] (${startTurnNum}턴~ 기록 중)`, "🧠 Genius Memory", { timeOut: 2500 });
            }
        }

        if (changed) {
            await saveChatConditional();
            renderLorebookList(gmData);
        }
    } catch (err) {
        console.warn("[Genius Memory] 사건 감지 패스:", err);
    } finally {
        isDetectingEvent = false;
    }
}

// 🌟 일괄 요약 시 구간 내의 모든 [완료된 사건]과 [진행 중 사건]의 시작~끝 턴을 찾아내는 스캐너 프롬프트
const BATCH_EVENT_SCANNER_PROMPT = `Role: Narrative Event Boundary Scanner.
Analyze the provided RP dialogue turns and [Currently Ongoing Events].
Identify:
1. All distinct narrative events/scenes that COMPLETED within these turns (including any [Currently Ongoing Events] that concluded during these turns).
2. Any notable event/scene that STARTED within these turns and is STILL ONGOING at the very last turn provided.

Output ONLY using one or more lines in this exact format (in the same language as the dialogue, or write NONE):
COMPLETED: [Event Title] | [Start Turn Number] | [End Turn Number]
ONGOING: [Event Title] | [Start Turn Number]`;

// 🌟 일괄 요약 중 해당 구간의 사건들을 스캔하여 로어북([완료] 및 [기록 중])을 자동 구축하는 함수
async function scanAndSummarizeEventsForBatch(batchIndices) {
    const context = getContext();
    const chat = context?.chat;
    const gmData = getChatGMData();
    if (!chat || !gmData || batchIndices.length === 0) return;

    const sTurn = batchIndices[0] + 1;
    const eTurn = batchIndices[batchIndices.length - 1] + 1;
    toastr.info(`🔍 ${sTurn}~${eTurn}턴 구간의 사건 로어북을 스캔 중...`, "🧠 Genius Memory");

    const lines = batchIndices.map(idx => `[Turn ${idx + 1}] ${chat[idx].name}: ${chat[idx].mes}`).join("\n\n");
    const ongoingListStr = gmData.ongoing_events.length > 0
        ? gmData.ongoing_events.map(e => `- "${e.title}" (Started at Turn ${e.startTurn})`).join("\n")
        : "None";

    const scannerInput = `[Currently Ongoing Events]\n${ongoingListStr}\n\n[Dialogue (Turns ${sTurn} to ${eTurn})]\n${lines}`;
    const result = await callSubAPI(BATCH_EVENT_SCANNER_PROMPT, scannerInput);

    // 1) 구간 내에서 완료된 사건들 -> 각각 시작~끝 턴을 정밀 로어북으로 생성!
    const completedMatches = [...result.matchAll(/COMPLETED:\s*([^|\n]+)\|\s*(\d+)\s*\|\s*(\d+)/gi)];
    for (const match of completedMatches) {
        const title = match[1].trim().replace(/^["']|["']$/g, "");
        let startT = Number(match[2]) || sTurn;
        const endT = Number(match[3]) || eTurn;

        if (title.toUpperCase() === "NONE") continue;

        // 만약 이전 구간부터 [기록 중]이던 사건이 이번에 끝난 거라면 원래 시작 턴을 유지하고 [기록 중]에서 제거
        const ongoingIdx = gmData.ongoing_events.findIndex(e =>
            title.toLowerCase().includes(e.title.toLowerCase()) ||
            e.title.toLowerCase().includes(title.toLowerCase())
        );
        if (ongoingIdx !== -1) {
            startT = gmData.ongoing_events[ongoingIdx].startTurn;
            gmData.ongoing_events.splice(ongoingIdx, 1);
        }

        await summarizeLoreEventRange(title, startT, Math.max(startT, endT));
    }

    // 2) 이번 구간에서 시작되었으나 아직 끝나지 않은 사건 -> [⏳ 기록 중]에 등록하여 다음 구간으로 토스!
    const ongoingMatches = [...result.matchAll(/ONGOING:\s*([^|\n]+)\|\s*(\d+)/gi)];
    for (const match of ongoingMatches) {
        const title = match[1].trim().replace(/^["']|["']$/g, "");
        const startT = Number(match[2]) || sTurn;

        if (
            title.toUpperCase() !== "NONE" &&
            !gmData.ongoing_events.some(e => e.title.toLowerCase() === title.toLowerCase())
        ) {
            gmData.ongoing_events.push({ title, startTurn: startT });
        }
    }

    await saveChatConditional();
    renderLorebookList(gmData);
}

// 선택 구간 메인 요약
async function summarizeSelectedRange() {
    if (isSummarizing) return toastr.warning("이미 요약이 진행 중입니다.", "Genius Memory");

    const startTurnVal = Number($("#gm-start-turn").val());
    const endTurnVal = Number($("#gm-end-turn").val());

    if (!startTurnVal || !endTurnVal || startTurnVal > endTurnVal) {
        return toastr.warning("올바른 시작 턴과 끝 턴을 지정해주세요. (메시지 점 3개 메뉴의 '<', '>' 버튼 활용)", "Genius Memory");
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const startIdx = Math.max(0, startTurnVal - 1);
    const endIdx = Math.min(chat.length - 1, endTurnVal - 1);

    const indices = [];
    for (let i = startIdx; i <= endIdx; i++) {
        if (!chat[i].extra?.isSmallSys) {
            indices.push(i);
        }
    }

    if (indices.length === 0) return toastr.warning("선택한 구간에 요약할 메시지가 없습니다.", "Genius Memory");

    $(".gm-drawer-layer").removeClass("gm-open");
    isSummarizing = true;
    try {
        await executeSummaryForIndices(indices);
        toastr.success(`${startIdx + 1} ~ ${endIdx + 1}턴 선택 구간 메인 요약 완료!`, "🧠 Genius Memory");
        clearRangeSelection();
    } catch (error) {
        console.error("[Genius Memory] 구간 요약 오류:", error);
        toastr.error(error.message, "Genius Memory 오류");
    } finally {
        isSummarizing = false;
    }
}

// 일괄 요약 및 자동 요약
async function runBatchOrAutoSummary(isManualBatch = false) {
    const s = extension_settings[extensionName];
    if (!s.enabled && !isManualBatch) return;
    if (isSummarizing) {
        if (isManualBatch) toastr.warning("이미 요약이 진행 중입니다.", "Genius Memory");
        return;
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const activeIndices = [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_system && !chat[i].extra?.isSmallSys) {
            activeIndices.push(i);
        }
    }

    const chunkSize = Number(s.chunk_size) || 10;
    const bufferSize = Number(s.buffer_size) || 2;
    const summarizablePool = activeIndices.slice(0, Math.max(0, activeIndices.length - bufferSize));

    if (!isManualBatch && summarizablePool.length < chunkSize) {
        return;
    }

    if (isManualBatch && summarizablePool.length === 0) {
        return toastr.info(`보호 버퍼(최근 ${bufferSize}턴)를 제외하면 요약할 밀린 대화가 없습니다.`, "Genius Memory");
    }

    if (isManualBatch) $(".gm-drawer-layer").removeClass("gm-open");
    isSummarizing = true;
    try {
        let cursor = 0;
        while (cursor < summarizablePool.length) {
            const remaining = summarizablePool.length - cursor;
            if (!isManualBatch && remaining < chunkSize) break;

            const batchIndices = summarizablePool.slice(cursor, cursor + chunkSize);
            await executeSummaryForIndices(batchIndices);

            // 🌟 일괄 요약(또는 자동 요약 시 누락 방지) 시 해당 구간의 사건 로어북도 함께 스캔 및 요약!
            if (isManualBatch) {
                await scanAndSummarizeEventsForBatch(batchIndices);
            }
            cursor += chunkSize;
        }
        if (isManualBatch) {
            // 마지막 보호 버퍼 구간에 걸쳐 있는 진행 중 사건까지 마저 감지
            await detectEventsOnTurn();
            toastr.success("밀린 대화 메인 요약 및 사건 로어북 일괄 생성이 모두 완료되었습니다!", "🧠 Genius Memory");
        }
        if (isManualBatch) {
            toastr.success("밀린 대화 일괄 요약이 모두 완료되었습니다!", "🧠 Genius Memory");
        }
    } catch (error) {
        console.error("[Genius Memory] 일괄 요약 오류:", error);
        toastr.error(error.message, "Genius Memory 오류");
    } finally {
        isSummarizing = false;
    }
}

// 이벤트 리스너 등록
function setupListeners() {
    $("#gm_enabled").on("change", function () {
        extension_settings[extensionName].enabled = $(this).prop("checked");
        saveSettingsDebounced();
        refreshUIAndPrompt();
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

    // 사이드바 닫기 시 자동 저장
    $("#gm-close-btn").on("click", async function () {
        $("#gm-sidebar").removeClass("gm-open");
        await autoSaveIfDirty(true);
    });

    // 책갈피 버튼 클릭 시 요약 컨트롤 팝업 열기/닫기
    $(document).on("click", "#gm-bookmark-btn", function () {
        $(".gm-drawer-layer").toggleClass("gm-open");
    });

    // 사이드바 탭 전환 (메인 상태창 <-> 사건 로어북)
    $(document).on("click", ".gm-tab-btn", function () {
        $(".gm-tab-btn").removeClass("active");
        $(this).addClass("active");
        $(".gm-tab-pane").removeClass("active");
        $(`#${$(this).attr("data-tab")}`).addClass("active");
    });

    // 아코디언 토글 (헤더 클릭 시 접기/펼치기)
    $(document).on("click", ".gm-fold-header", function (e) {
        if ($(e.target).closest(".gm-lore-del, button").length > 0) return;
        $(this).closest(".gm-fold-box").toggleClass("gm-collapsed");
    });

    // 점 3개 메뉴 안의 '<' (시작점), '>' (끝점) 클릭
    $(document).on("click", ".gm-set-start", function (e) {
        e.stopPropagation();
        selectedStartIdx = Number($(this).attr("data-mesid"));
        if (selectedEndIdx !== null && selectedEndIdx < selectedStartIdx) {
            selectedEndIdx = selectedStartIdx;
        }
        updateRangeHighlight();
        $("#gm-sidebar").addClass("gm-open");
        $(".gm-drawer-layer").addClass("gm-open");
        toastr.info(`요약 시작점: ${selectedStartIdx + 1}턴 선택됨`, "Genius Memory", { timeOut: 1500 });
    });

    $(document).on("click", ".gm-set-end", function (e) {
        e.stopPropagation();
        selectedEndIdx = Number($(this).attr("data-mesid"));
        if (selectedStartIdx === null || selectedStartIdx > selectedEndIdx) {
            selectedStartIdx = selectedEndIdx;
        }
        updateRangeHighlight();
        $("#gm-sidebar").addClass("gm-open");
        $(".gm-drawer-layer").addClass("gm-open");
        toastr.info(`요약 끝점: ${selectedEndIdx + 1}턴 선택됨`, "Genius Memory", { timeOut: 1500 });
    });

    $("#gm-start-turn").on("input", function () {
        const val = Number($(this).val());
        selectedStartIdx = val > 0 ? val - 1 : null;
        updateRangeHighlight();
    });
    $("#gm-end-turn").on("input", function () {
        const val = Number($(this).val());
        selectedEndIdx = val > 0 ? val - 1 : null;
        updateRangeHighlight();
    });

    $("#gm-clear-range-btn").on("click", clearRangeSelection);
    $("#gm-range-sum-btn").on("click", summarizeSelectedRange);
    $("#gm-batch-sum-btn").on("click", () => runBatchOrAutoSummary(true));

    // 선택 구간을 사건 로어북으로 즉시 정밀 요약
    $("#gm-range-lore-btn").on("click", async function () {
        const startTurnVal = Number($("#gm-start-turn").val());
        const endTurnVal = Number($("#gm-end-turn").val());
        if (!startTurnVal || !endTurnVal || startTurnVal > endTurnVal) {
            return toastr.warning("올바른 시작~끝 턴을 먼저 지정해주세요.", "Genius Memory");
        }
        const customTitle = prompt("이 구간의 사건 제목을 입력해주세요 (비워두면 AI가 자동 작성):", "");
        if (customTitle === null) return;
        $(".gm-drawer-layer").removeClass("gm-open");
        await summarizeLoreEventRange(customTitle.trim(), startTurnVal, endTurnVal);
        clearRangeSelection();
    });

    // 수동으로 현재 조각들을 통합 요약으로 합치기
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

    // 요약 점선 클릭 시 숨김 해제
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
        toastr.info(`${startIdx + 1} ~ ${endIdx + 1}턴 메시지의 숨김 처리가 해제되었습니다.`, "Genius Memory");
    });

    // 텍스트 수정 감지 -> 롤백 버튼 활성화 표시
    $(document).on("input", "#gm-macro-summary, .gm-chunk-input, #gm-state-tracker, #gm-open-tracker, #gm-items-tracker", function () {
        isStateDirty = true;
        $("#gm-rollback-state-btn").addClass("gm-has-unsaved");
    });

    $(document).on("input", ".gm-lore-title, .gm-lore-keys-only, .gm-lore-content", function () {
        isLoreDirty = true;
        $("#gm-rollback-lore-btn").addClass("gm-has-unsaved");
    });

    // 마지막 저장값으로 롤백 (메인 상태창)
    $("#gm-rollback-state-btn").on("click", function () {
        if (!isStateDirty) return toastr.info("되돌릴 수정사항이 없습니다.", "Genius Memory", { timeOut: 1200 });
        isStateDirty = false;
        $("#gm-rollback-state-btn").removeClass("gm-has-unsaved");
        refreshUIAndPrompt();
        toastr.info("수정을 취소하고 마지막 저장값으로 되돌렸습니다.", "↩️ 롤백 완료");
    });

    // 마지막 저장값으로 롤백 (사건 로어북)
    $("#gm-rollback-lore-btn").on("click", function () {
        if (!isLoreDirty) return toastr.info("되돌릴 로어북 수정사항이 없습니다.", "Genius Memory", { timeOut: 1200 });
        isLoreDirty = false;
        $("#gm-rollback-lore-btn").removeClass("gm-has-unsaved");
        const gmData = getChatGMData();
        if (gmData) renderLorebookList(gmData);
        toastr.info("로어북 수정을 취소하고 마지막 저장값으로 되돌렸습니다.", "↩️ 롤백 완료");
    });

    // [기록 중] 사건 수동 등록
    $("#gm-add-ongoing-btn").on("click", async function () {
        const gmData = getChatGMData();
        const context = getContext();
        if (!gmData || !context?.chat) return;
        const defaultTurn = context.chat.length || 1;
        const title = prompt("현재 시작된 사건의 이름을 입력하세요 (예: 점심 식사):", "");
        if (!title) return;
        const turnInput = prompt(`몇 번째 턴부터 시작되었나요? (현재 마지막 턴: ${defaultTurn})`, String(defaultTurn));
        const sTurn = Number(turnInput) || defaultTurn;

        gmData.ongoing_events.push({ title: title.trim(), startTurn: sTurn });
        await saveChatConditional();
        renderLorebookList(gmData);
    });

    // [기록 중] 사건 [✅ 지금 완료] 클릭
    $(document).on("click", ".gm-finish-event-btn", async function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        const context = getContext();
        if (!gmData || !context?.chat) return;

        const targetEvent = gmData.ongoing_events[idx];
        if (!targetEvent) return;
        const currentLastTurn = context.chat.length;
        const endTurn = Math.max(targetEvent.startTurn, currentLastTurn);

        gmData.ongoing_events.splice(idx, 1);
        renderLorebookList(gmData);
        await summarizeLoreEventRange(targetEvent.title, targetEvent.startTurn, endTurn);
    });

    // [기록 중] 사건 취소(X) 클릭
    $(document).on("click", ".gm-ongoing-del", async function (e) {
        e.stopPropagation();
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        if (!gmData) return;
        gmData.ongoing_events.splice(idx, 1);
        await saveChatConditional();
        renderLorebookList(gmData);
    });

    // 빈 완료 사건 카드 수동 추가
    $("#gm-add-lore-btn").on("click", function () {
        const gmData = getChatGMData();
        if (!gmData) return;
        gmData.micro_events.push({ title: "수동 사건", startTurn: "수동", endTurn: "기록", keys: [], content: "", vector: [] });
        renderLorebookList(gmData);
    });

    // 완료된 사건 로어북 삭제 (연타 방지 잠금 포함)
    $(document).on("click", ".gm-lore-del", async function (e) {
        e.stopPropagation();
        if (isDeletingLore) return;
        isDeletingLore = true;

        const card = $(this).closest(".gm-lore-card");
        const idx = Number($(this).attr("data-idx"));
        const gmData = getChatGMData();
        if (!gmData) {
            isDeletingLore = false;
            return;
        }

        card.addClass("gm-deleting");
        card.find(".gm-lore-badge").text("⏳ 삭제 중...");

        try {
            gmData.micro_events.splice(idx, 1);
            await saveChatConditional();
            await updatePromptInjection(gmData);
        } finally {
            isDeletingLore = false;
        }
    });

    // 백업 내보내기 (.json)
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

    // 백업 불러오기 (.json)
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
                isStateDirty = false;
                isLoreDirty = false;
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

// 하단 마법봉 메뉴에 버튼 추가
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
        $("#gm-sidebar").toggleClass("gm-open");
        if (isClosing) await autoSaveIfDirty(true);
    });
}

// 확장 프로그램 초기화
jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        const $parsed = $(settingsHtml);

        $("#extensions_settings").append($parsed.filter(".genius-memory-settings"));
        $("body").append($parsed.filter("#gm-sidebar"));

        loadSettings();
        setupListeners();
        addToWandMenu();

        eventSource.on(event_types.CHAT_CHANGED, () => {
            clearRangeSelection();
            isStateDirty = false;
            isLoreDirty = false;
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

        console.log("[Genius Memory] 최종 초기화 완료!");
    } catch (error) {
        console.error("[Genius Memory] 초기화 실패:", error);
    }
});