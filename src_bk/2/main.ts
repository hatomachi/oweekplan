import { Plugin, WorkspaceLeaf, TextFileView, Notice } from 'obsidian';
import { Calendar } from '@fullcalendar/core';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin, { Draggable } from '@fullcalendar/interaction';
import * as yaml from 'js-yaml';

export const WEEKPLAN_VIEW_TYPE = "weekplan-view";

export class WeekplanView extends TextFileView {
    calendar: Calendar;
    yamlData: any;
    leftPanelEl: HTMLElement;
    draggable: Draggable | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
        this.yamlData = { ai_insight: "", goals: [], events: [] };
    }

    getViewType() { return WEEKPLAN_VIEW_TYPE; }
    getDisplayText() { return this.file ? this.file.basename : "Weekplan"; }

    async onOpen() {
        const container = this.contentEl;
        container.empty();

        // 全体のコンテナを左右分割のFlexboxに設定
        container.style.display = 'flex';
        container.style.flexDirection = 'row';
        container.style.height = '100%';
        container.style.overflow = 'hidden';

        // 🟢 左ペイン
        this.leftPanelEl = container.createEl('div', {
            cls: 'weekplan-left-panel',
            attr: { style: 'width: 350px; flex-shrink: 0; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px;' }
        });

        // 🟡 リサイザー（境界線）
        const resizer = container.createEl('div', {
            cls: 'weekplan-resizer',
            attr: { style: 'width: 4px; cursor: col-resize; background-color: var(--background-modifier-border); transition: background-color 0.2s;' }
        });

        resizer.addEventListener('mouseenter', () => resizer.style.backgroundColor = 'var(--interactive-accent)');
        resizer.addEventListener('mouseleave', () => resizer.style.backgroundColor = 'var(--background-modifier-border)');

        // 🔵 右ペイン（カレンダーとヘッダー）
        const rightPanelEl = container.createEl('div', {
            cls: 'weekplan-right-panel',
            attr: { style: 'flex-grow: 1; display: flex; flex-direction: column; height: 100%; overflow: hidden; min-width: 300px;' }
        });

        // --- ドラッグで幅を変更するロジック ---
        let isResizing = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const containerRect = container.getBoundingClientRect();
            const newWidth = e.clientX - containerRect.left;

            if (newWidth > 150 && newWidth < containerRect.width - 300) {
                this.leftPanelEl.style.width = `${newWidth}px`;
            }
            if (this.calendar) {
                this.calendar.updateSize();
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = 'default';
            }
        });

        // --- ヘッダー（同期ボタン） ---
        const header = rightPanelEl.createEl('div', { attr: { style: 'padding: 10px; border-bottom: 1px solid var(--background-modifier-border);' } });
        const syncBtn = header.createEl('button', { text: '🔄 Outlook予定を取得' });

        syncBtn.addEventListener('click', async () => {
            new Notice('Outlook予定を取得中...');
            try {
                const path = require('path');
                const { exec } = require('child_process');
                const adapter = this.app.vault.adapter as any;
                const vaultPath = adapter.getBasePath();
                const scriptPath = path.join(vaultPath, 'stub_fetch.py');
                const command = `python3 "${scriptPath}"`;

                exec(command, async (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        console.error('Python Error:', error, stderr);
                        new Notice('予定の取得に失敗しました');
                        return;
                    }
                    try {
                        const newEvents = JSON.parse(stdout);
                        const currentData = this.yamlData || { events: [] };
                        if (!currentData.events) currentData.events = [];

                        currentData.events = currentData.events.filter((ev: any) => ev.type !== 'outlook');
                        currentData.events.push(...newEvents);

                        const newYaml = yaml.dump(currentData);
                        if (this.file) {
                            await this.app.vault.modify(this.file, newYaml);
                            new Notice('予定を同期しました！');
                        }
                    } catch (e) {
                        new Notice('データの解析に失敗しました');
                    }
                });
            } catch (err) {
                new Notice('システムエラー: モジュール読み込み失敗');
            }
        });

        const calendarEl = rightPanelEl.createEl('div', { attr: { style: 'flex-grow: 1; padding: 10px;' } });

        // --- FullCalendarの初期化 ---
        this.calendar = new Calendar(calendarEl, {
            plugins: [timeGridPlugin, interactionPlugin],
            initialView: 'timeGridWeek',
            firstDay: 1,
            editable: true,     // カレンダー上での予定の移動・伸縮を許可
            droppable: true,    // 外部（左ペイン）からのドロップを許可
            slotLabelFormat: { hour: 'numeric', minute: '2-digit', hour12: false },
            eventTimeFormat: { hour: 'numeric', minute: '2-digit', hour12: false },
            headerToolbar: { left: 'prev,next', center: 'title', right: '' },
            allDaySlot: false,
            slotMinTime: '08:00:00',
            slotMaxTime: '22:00:00',
            events: [],

            // ① 外部（左ペイン）から新しくドロップされた時
            eventReceive: async (info) => {
                await this.handleEventChange(info.event, 'receive');
            },
            // ② カレンダー内で時間を移動（ドラッグ）させた時
            eventDrop: async (info) => {
                await this.handleEventChange(info.event, 'update');
            },
            // ③ カレンダー内で予定の長さ（実績）を変えた時
            eventResize: async (info) => {
                await this.handleEventChange(info.event, 'update');
            }
        });

        this.calendar.render();
        setTimeout(() => this.calendar.updateSize(), 100);
    }

    // --- YAML保存用の共通処理（クラスの直下に配置） ---
    formatLocalISO(date: Date) {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
    }

    async handleEventChange(event: any, action: 'receive' | 'update') {
        if (!this.file || !this.yamlData) return;

        // 1. events配列の更新
        const eventIndex = this.yamlData.events.findIndex((e: any) => e.id === event.id);
        const newEventData = {
            id: event.id,
            type: 'task',
            title: event.title,
            start: this.formatLocalISO(event.start),
            end: event.end ? this.formatLocalISO(event.end) : this.formatLocalISO(new Date(event.start.getTime() + 60 * 60 * 1000)),
            color: event.backgroundColor || '#10b981'
        };

        if (eventIndex >= 0) {
            this.yamlData.events[eventIndex] = { ...this.yamlData.events[eventIndex], ...newEventData };
        } else {
            this.yamlData.events.push(newEventData);
        }

        // 2. 左ペイン（goals）のステータス更新
        if (action === 'receive' && this.yamlData.goals) {
            this.yamlData.goals.forEach((role: any) => {
                role.items?.forEach((task: any) => {
                    if (task.id === event.id) {
                        task.status = 'scheduled';
                    }
                });
            });
        }

        // 3. YAMLファイルへの上書き保存
        const newYaml = yaml.dump(this.yamlData);
        await this.app.vault.modify(this.file, newYaml);
        new Notice('予定を更新しました');
    }

    async onClose() {
        if (this.draggable) this.draggable.destroy();
        if (this.calendar) this.calendar.destroy();
    }

    getViewData() {
        return yaml.dump(this.yamlData);
    }

    setViewData(data: string, clear: boolean) {
        try {
            this.yamlData = yaml.load(data) || { ai_insight: "", goals: [], events: [] };

            this.calendar.removeAllEvents();
            if (this.yamlData.events && Array.isArray(this.yamlData.events)) {
                this.yamlData.events.forEach((ev: any) => {
                    this.calendar.addEvent({
                        id: ev.id,
                        title: ev.title,
                        start: ev.start,
                        end: ev.end,
                        backgroundColor: ev.color || '#3b82f6',
                        borderColor: ev.color || '#3b82f6',
                    });
                });
            }

            this.renderLeftPanel();

        } catch (e) {
            console.error("YAML parse error:", e);
        }
    }

    renderLeftPanel() {
        this.leftPanelEl.empty();

        if (this.draggable) {
            this.draggable.destroy();
        }

        // --- エリアA：AIインサイト ---
        if (this.yamlData.ai_insight) {
            const calloutEl = this.leftPanelEl.createEl('div', {
                attr: { style: 'background-color: var(--background-secondary); border-left: 4px solid var(--interactive-accent); padding: 12px; border-radius: 4px;' }
            });
            calloutEl.createEl('h4', { text: '💡 AI 作戦会議メモ', attr: { style: 'margin: 0 0 8px 0; font-size: 14px; color: var(--text-normal);' } });

            const lines = this.yamlData.ai_insight.split('\n');
            lines.forEach((line: string) => {
                calloutEl.createEl('p', { text: line, attr: { style: 'margin: 0 0 4px 0; font-size: 13px; color: var(--text-muted); line-height: 1.4;' } });
            });
        }

        // --- エリアB：タスクツリー ---
        const treeContainer = this.leftPanelEl.createEl('div');
        treeContainer.createEl('h3', { text: '🎯 今週の目標とタスク', attr: { style: 'margin: 0 0 15px 0; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 5px;' } });

        if (this.yamlData.goals && Array.isArray(this.yamlData.goals)) {
            this.yamlData.goals.forEach((roleGroup: any) => {
                treeContainer.createEl('div', {
                    text: `▼ ${roleGroup.role}`,
                    attr: { style: 'font-weight: bold; margin-bottom: 8px; color: var(--text-normal);' }
                });

                if (roleGroup.items && Array.isArray(roleGroup.items)) {
                    const listEl = treeContainer.createEl('ul', { attr: { style: 'list-style-type: none; padding-left: 15px; margin-top: 0; margin-bottom: 15px;' } });

                    roleGroup.items.forEach((task: any) => {
                        const li = listEl.createEl('li', {
                            attr: { style: 'margin-bottom: 6px; font-size: 13px; display: flex; align-items: flex-start; gap: 6px; cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background-color 0.2s;' }
                        });

                        let icon = '⚪';
                        let opacity = '1.0';
                        let textDecoration = 'none';
                        let timeString = '';

                        if (task.status === 'scheduled') {
                            icon = '🟢';
                            const eventData = this.yamlData.events?.find((e: any) => e.id === task.id);
                            if (eventData && eventData.start) {
                                const startDate = new Date(eventData.start);
                                const endDate = new Date(eventData.end);
                                const days = ['日', '月', '火', '水', '木', '金', '土'];
                                const dayStr = days[startDate.getDay()];

                                const startStr = `${startDate.getHours()}:${startDate.getMinutes().toString().padStart(2, '0')}`;
                                const endStr = `${endDate.getHours()}:${endDate.getMinutes().toString().padStart(2, '0')}`;

                                timeString = ` <span style="color: var(--text-muted); font-size: 11px;">(${dayStr} ${startStr}-${endStr})</span>`;
                            }
                        } else if (task.status === 'pool') {
                            icon = '🟡';
                            li.classList.add('fc-event-draggable');
                            li.setAttribute('data-id', task.id);
                            li.setAttribute('data-title', task.title);

                            const hours = task.estimated_hours ? parseFloat(task.estimated_hours) : 1;
                            const h = Math.floor(hours);
                            const m = Math.round((hours - h) * 60);
                            const durationStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
                            li.setAttribute('data-duration', durationStr);

                            li.style.cursor = 'grab';
                        } else if (task.status === 'dropped') {
                            icon = '⚪';
                            opacity = '0.5';
                            textDecoration = 'line-through';
                        }

                        li.createEl('span', { text: icon, attr: { style: 'font-size: 12px; margin-top: 2px;' } });

                        const hoursStr = task.estimated_hours ? `[${task.estimated_hours}h] ` : '';

                        const textSpan = li.createEl('span', {
                            attr: { style: `opacity: ${opacity}; text-decoration: ${textDecoration}; color: var(--text-normal); line-height: 1.4;` }
                        });
                        textSpan.innerHTML = `${hoursStr}${task.title}${timeString}`;

                        if (task.status === 'scheduled' && this.calendar) {
                            li.addEventListener('mouseenter', () => {
                                li.style.backgroundColor = 'var(--background-modifier-hover)';
                                const eventObj = this.calendar.getEventById(task.id);
                                if (eventObj) {
                                    eventObj.setProp('borderColor', 'var(--text-error)');
                                    eventObj.setProp('backgroundColor', 'var(--interactive-accent-hover)');
                                }
                            });
                            li.addEventListener('mouseleave', () => {
                                li.style.backgroundColor = 'transparent';
                                const eventObj = this.calendar.getEventById(task.id);
                                if (eventObj) {
                                    const origColor = this.yamlData.events?.find((e: any) => e.id === task.id)?.color || '#3b82f6';
                                    eventObj.setProp('borderColor', origColor);
                                    eventObj.setProp('backgroundColor', origColor);
                                }
                            });
                        }
                    });
                }
            });
        }

        // --- ドラッグ機能の初期化 ---
        this.draggable = new Draggable(this.leftPanelEl, {
            itemSelector: '.fc-event-draggable',
            eventData: function (eventEl) {
                return {
                    id: eventEl.getAttribute('data-id'),
                    title: eventEl.getAttribute('data-title'),
                    duration: eventEl.getAttribute('data-duration'),
                    backgroundColor: '#10b981',
                    borderColor: '#10b981'
                };
            }
        });
    }

    clear() {
        this.yamlData = { ai_insight: "", goals: [], events: [] };
        if (this.calendar) this.calendar.removeAllEvents();
        if (this.leftPanelEl) this.leftPanelEl.empty();
    }
}

export default class WeekplanPlugin extends Plugin {
    async onload() {
        this.registerView(WEEKPLAN_VIEW_TYPE, (leaf) => new WeekplanView(leaf));
        this.registerExtensions(['weekplan'], WEEKPLAN_VIEW_TYPE);

        this.addCommand({
            id: 'create-weekplan',
            name: '今週の作戦会議ファイルを作成',
            callback: async () => {
                const fileName = `2026-W08.weekplan`;
                const fileContent = `week: "2026-W08"\nai_insight: |\n  ここにAIとの作戦会議のサマリーや方針が記録されます。\ngoals:\n  - role: "サンプル役割"\n    items:\n      - id: "task-1"\n        title: "サンプルのタスク"\n        estimated_hours: 1.0\n        status: "pool"\nevents: []\n`;
                const existingFile = this.app.vault.getAbstractFileByPath(fileName);
                if (!existingFile) {
                    await this.app.vault.create(fileName, fileContent);
                    new Notice(`${fileName} を作成しました`);
                } else {
                    new Notice(`すでに ${fileName} は存在します`);
                }
            }
        });
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(WEEKPLAN_VIEW_TYPE);
    }
}