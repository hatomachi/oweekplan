import { Plugin, WorkspaceLeaf, TextFileView, Notice, Modal, App, Setting } from 'obsidian';
import { Calendar } from '@fullcalendar/core';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin, { Draggable } from '@fullcalendar/interaction';
import * as yaml from 'js-yaml';
import { MyPluginSettings, DEFAULT_SETTINGS, SampleSettingTab } from './settings';

export const WEEKPLAN_VIEW_TYPE = "weekplan-view";

class TaskInputModal extends Modal {
    resultTitle: string = "";
    resultHours: string = "1.0";
    roleName: string;
    onSubmit: (title: string, hours: string) => void;

    constructor(app: App, roleName: string, onSubmit: (title: string, hours: string) => void) {
        super(app);
        this.roleName = roleName;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: `「${this.roleName}」にタスクを追加` });

        new Setting(contentEl)
            .setName("タスク名")
            .addText((text) =>
                text.onChange((value) => {
                    this.resultTitle = value;
                })
            );

        new Setting(contentEl)
            .setName("見積もり時間 (h)")
            .setDesc("例: 1.5")
            .addText((text) =>
                text.setValue(this.resultHours)
                    .onChange((value) => {
                        this.resultHours = value;
                    })
            );

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("追加する")
                    .setCta()
                    .onClick(() => {
                        this.close();
                        if (this.resultTitle.trim() !== "") {
                            this.onSubmit(this.resultTitle, this.resultHours);
                        }
                    })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class WeekplanView extends TextFileView {
    calendar: Calendar;
    yamlData: any;
    visualContainer: HTMLElement;
    sourceContainer: HTMLTextAreaElement;
    leftPanelEl: HTMLElement;
    draggable: Draggable | null = null;
    isSourceMode: boolean = false;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
        this.yamlData = { insight: "", goals: [], events: [] };
    }

    getViewType() { return WEEKPLAN_VIEW_TYPE; }
    getDisplayText() { return this.file ? this.file.basename : "Weekplan"; }

    async onOpen() {
        const container = this.contentEl;
        container.empty();

        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.height = '100%';
        container.style.overflow = 'hidden';

        const header = container.createEl('div', {
            attr: { style: 'padding: 10px; border-bottom: 1px solid var(--background-modifier-border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;' }
        });

        const leftControls = header.createEl('div', { attr: { style: 'display: flex; gap: 10px;' } });
        const syncBtn = leftControls.createEl('button', { text: '🔄 Outlook同期' });
        const toggleModeBtn = header.createEl('button', { text: '</> ソースモード' });

        const contentArea = container.createEl('div', {
            attr: { style: 'flex-grow: 1; display: flex; overflow: hidden; position: relative;' }
        });

        this.visualContainer = contentArea.createEl('div', {
            attr: { style: 'display: flex; flex-direction: row; height: 100%; width: 100%; overflow: hidden;' }
        });

        this.sourceContainer = contentArea.createEl('textarea', {
            cls: 'weekplan-source-editor',
            attr: { style: 'display: none; width: 100%; height: 100%; font-family: monospace; padding: 15px; resize: none; border: none; outline: none; background: var(--background-primary); color: var(--text-normal); font-size: 14px; line-height: 1.5;' }
        });

        this.leftPanelEl = this.visualContainer.createEl('div', {
            cls: 'weekplan-left-panel',
            attr: { style: 'width: 350px; flex-shrink: 0; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px;' }
        });

        const resizer = this.visualContainer.createEl('div', {
            cls: 'weekplan-resizer',
            attr: { style: 'width: 4px; cursor: col-resize; background-color: var(--background-modifier-border); transition: background-color 0.2s;' }
        });
        resizer.addEventListener('mouseenter', () => resizer.style.backgroundColor = 'var(--interactive-accent)');
        resizer.addEventListener('mouseleave', () => resizer.style.backgroundColor = 'var(--background-modifier-border)');

        const rightPanelEl = this.visualContainer.createEl('div', {
            cls: 'weekplan-right-panel',
            attr: { style: 'flex-grow: 1; display: flex; flex-direction: column; height: 100%; overflow: hidden; min-width: 300px;' }
        });

        let isResizing = false;
        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const containerRect = this.visualContainer.getBoundingClientRect();
            const newWidth = e.clientX - containerRect.left;
            if (newWidth > 150 && newWidth < containerRect.width - 300) {
                this.leftPanelEl.style.width = `${newWidth}px`;
            }
            if (this.calendar) this.calendar.updateSize();
        });
        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = 'default';
            }
        });

        toggleModeBtn.addEventListener('click', async () => {
            this.isSourceMode = !this.isSourceMode;
            if (this.isSourceMode) {
                this.sourceContainer.value = yaml.dump(this.yamlData);
                this.visualContainer.style.display = 'none';
                this.sourceContainer.style.display = 'block';
                toggleModeBtn.innerText = '👁️ ビジュアルモード';
            } else {
                const newText = this.sourceContainer.value;
                try {
                    yaml.load(newText);
                    if (this.file) await this.app.vault.modify(this.file, newText);
                    this.sourceContainer.style.display = 'none';
                    this.visualContainer.style.display = 'flex';
                    toggleModeBtn.innerText = '</> ソースモード';
                } catch (e) {
                    new Notice('YAMLの構文エラーがあります。修正してください。');
                    this.isSourceMode = true;
                }
            }
        });

        syncBtn.addEventListener('click', async () => {
            new Notice('Outlook予定を取得中...');
            try {
                const path = require('path');
                const { exec } = require('child_process');
                const adapter = this.app.vault.adapter as any;
                const vaultPath = adapter.getBasePath();
                const scriptPath = path.join(vaultPath, 'stub_fetch.py');
                exec(`python3 "${scriptPath}"`, async (error: any, stdout: string, stderr: string) => {
                    if (error) { new Notice('予定の取得に失敗しました'); return; }
                    try {
                        const newEvents = JSON.parse(stdout);
                        const currentData = this.yamlData || { events: [] };
                        if (!currentData.events) currentData.events = [];
                        currentData.events = currentData.events.filter((ev: any) => ev.type !== 'outlook');
                        currentData.events.push(...newEvents);

                        // 🌟 追加：Outlook同期後も予定を開始時間順にソート
                        currentData.events.sort((a: any, b: any) => {
                            return new Date(a.start).getTime() - new Date(b.start).getTime();
                        });

                        if (this.file) await this.app.vault.modify(this.file, yaml.dump(currentData));
                        new Notice('予定を同期しました！');
                    } catch (e) { new Notice('データの解析に失敗しました'); }
                });
            } catch (err) { new Notice('システムエラー'); }
        });

        const calendarEl = rightPanelEl.createEl('div', { attr: { style: 'flex-grow: 1; padding: 10px;' } });
        this.calendar = new Calendar(calendarEl, {
            plugins: [timeGridPlugin, interactionPlugin],
            initialView: 'timeGridWeek',
            firstDay: 1,
            editable: true,
            droppable: true,
            slotLabelFormat: { hour: 'numeric', minute: '2-digit', hour12: false },
            eventTimeFormat: { hour: 'numeric', minute: '2-digit', hour12: false },
            headerToolbar: { left: 'prev,next', center: 'title', right: '' },
            allDaySlot: false,
            slotMinTime: '08:00:00',
            slotMaxTime: '22:00:00',
            events: [],
            eventReceive: async (info) => await this.handleEventChange(info.event, 'receive'),
            eventDrop: async (info) => await this.handleEventChange(info.event, 'update'),
            eventResize: async (info) => await this.handleEventChange(info.event, 'update'),

            eventClick: async (info) => {
                if (info.event.extendedProps?.type === 'outlook') {
                    new Notice('Outlookの固定予定は変更できません。');
                    return;
                }

                if (confirm(`予定枠「${info.event.title}」を削除しますか？`)) {
                    this.yamlData.events = this.yamlData.events.filter((e: any) => e.id !== info.event.id);
                    this.updateTaskStatuses();
                    if (this.file) await this.app.vault.modify(this.file, yaml.dump(this.yamlData));
                    new Notice('予定枠を削除しました。');
                }
            }
        });

        this.calendar.render();
        setTimeout(() => this.calendar.updateSize(), 100);
    }

    formatLocalISO(date: Date) {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
    }

    updateTaskStatuses() {
        if (!this.yamlData.goals) return;

        const taskHours = new Map<string, number>();

        this.yamlData.events?.forEach((ev: any) => {
            if (ev.type === 'task') {
                const taskId = ev.taskId || ev.id;
                if (ev.start && ev.end) {
                    const start = new Date(ev.start).getTime();
                    const end = new Date(ev.end).getTime();
                    const hours = (end - start) / (1000 * 60 * 60);
                    taskHours.set(taskId, (taskHours.get(taskId) || 0) + hours);
                }
            }
        });

        this.yamlData.goals.forEach((role: any) => {
            role.items?.forEach((task: any) => {
                if (task.status === 'dropped' || task.status === 'completed') return;

                const totalScheduled = taskHours.get(task.id) || 0;
                const estimated = parseFloat(task.estimated_hours) || 1;

                if (totalScheduled === 0) {
                    task.status = 'pool';
                } else if (totalScheduled < estimated) {
                    task.status = 'partial';
                } else {
                    task.status = 'scheduled';
                }
            });
        });
    }

    async handleEventChange(event: any, action: 'receive' | 'update') {
        if (!this.file || !this.yamlData) return;

        const eventIndex = this.yamlData.events.findIndex((e: any) => e.id === event.id);
        const newEventData = {
            id: event.id,
            taskId: event.extendedProps?.taskId || event.id,
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

        // 🌟 追加：カレンダーの操作後、予定を開始時間（時系列）順にソートする
        this.yamlData.events.sort((a: any, b: any) => {
            return new Date(a.start).getTime() - new Date(b.start).getTime();
        });

        this.updateTaskStatuses();
        if (this.file) await this.app.vault.modify(this.file, yaml.dump(this.yamlData));
    }

    async onClose() {
        if (this.draggable) this.draggable.destroy();
        if (this.calendar) this.calendar.destroy();
    }

    getViewData() {
        if (this.isSourceMode) return this.sourceContainer.value;
        return yaml.dump(this.yamlData);
    }

    setViewData(data: string, clear: boolean) {
        if (this.isSourceMode) {
            if (this.sourceContainer.value !== data) {
                this.sourceContainer.value = data;
            }
            return;
        }

        try {
            this.yamlData = yaml.load(data) || { insight: "", goals: [], events: [] };

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
                        extendedProps: { type: ev.type, taskId: ev.taskId || ev.id }
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
        if (this.draggable) this.draggable.destroy();

        const insightText = this.yamlData.insight || this.yamlData.ai_insight;
        if (insightText) {
            const calloutEl = this.leftPanelEl.createEl('div', {
                attr: { style: 'background-color: var(--background-secondary); border-left: 4px solid var(--interactive-accent); padding: 12px; border-radius: 4px;' }
            });
            calloutEl.createEl('h4', { text: '💡 石の配置の考え方', attr: { style: 'margin: 0 0 8px 0; font-size: 14px; color: var(--text-normal);' } });

            const lines = insightText.split('\n');
            lines.forEach((line: string) => {
                calloutEl.createEl('p', { text: line, attr: { style: 'margin: 0 0 4px 0; font-size: 13px; color: var(--text-muted); line-height: 1.4;' } });
            });
        }

        const treeContainer = this.leftPanelEl.createEl('div');
        treeContainer.createEl('h3', { text: '🎯 今週の目標とタスク', attr: { style: 'margin: 0 0 15px 0; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 5px;' } });

        if (this.yamlData.goals && Array.isArray(this.yamlData.goals)) {
            this.yamlData.goals.forEach((roleGroup: any) => {

                const roleHeader = treeContainer.createEl('div', {
                    attr: { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;' }
                });
                roleHeader.createEl('span', { text: `▼ ${roleGroup.role}`, attr: { style: 'font-weight: bold; color: var(--text-normal);' } });

                const addBtn = roleHeader.createEl('button', { text: '+ タスク', attr: { style: 'font-size: 11px; padding: 2px 8px; height: auto;' } });
                addBtn.addEventListener('click', () => {
                    new TaskInputModal(this.app, roleGroup.role, async (title, hoursStr) => {
                        const hours = parseFloat(hoursStr) || 1.0;
                        const newTask = {
                            id: `task-${Date.now()}`,
                            title: title,
                            estimated_hours: hours,
                            status: "pool"
                        };

                        if (!roleGroup.items) roleGroup.items = [];
                        roleGroup.items.push(newTask);

                        if (this.file) {
                            await this.app.vault.modify(this.file, yaml.dump(this.yamlData));
                            new Notice('タスクを追加しました！');
                        }
                    }).open();
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

                        let totalScheduledHours = 0;
                        if (task.status === 'scheduled' || task.status === 'partial') {
                            const taskEvents = this.yamlData.events?.filter((e: any) => e.type === 'task' && (e.taskId === task.id || e.id === task.id)) || [];
                            taskEvents.forEach((e: any) => {
                                if (e.start && e.end) {
                                    totalScheduledHours += (new Date(e.end).getTime() - new Date(e.start).getTime()) / (1000 * 60 * 60);
                                }
                            });
                        }
                        const estimated = task.estimated_hours ? parseFloat(task.estimated_hours) : 1;

                        if (task.status === 'scheduled') {
                            icon = '🟢';
                            timeString = ` <span style="color: var(--text-muted); font-size: 11px;">(${Math.round(totalScheduledHours * 10) / 10}h/${estimated}h)</span>`;
                        } else if (task.status === 'partial') {
                            icon = '🌓';
                            timeString = ` <span style="color: var(--text-muted); font-size: 11px;">(${Math.round(totalScheduledHours * 10) / 10}h/${estimated}h)</span>`;
                        } else if (task.status === 'completed') {
                            icon = '☑️';
                            opacity = '0.5';
                            textDecoration = 'line-through';
                        } else if (task.status === 'dropped') {
                            icon = 'ー';
                            opacity = '0.5';
                            textDecoration = 'none';
                        }

                        if (task.status === 'pool' || task.status === 'partial') {
                            if (task.status === 'pool') icon = '🟡';
                            li.classList.add('fc-event-draggable');
                            li.setAttribute('data-id', task.id);
                            li.setAttribute('data-title', task.title);
                            const remainingHours = Math.max(0.25, estimated - totalScheduledHours);
                            const h = Math.floor(remainingHours);
                            const m = Math.round((remainingHours - h) * 60);
                            li.setAttribute('data-duration', `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
                            li.style.cursor = 'grab';
                        }

                        const iconSpan = li.createEl('span', { text: icon, attr: { style: 'font-size: 12px; margin-top: 2px; cursor: pointer; user-select: none;' } });
                        iconSpan.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            if (task.status === 'completed') {
                                task.status = 'dropped';
                            } else if (task.status === 'dropped') {
                                task.status = 'pool';
                                this.updateTaskStatuses();
                            } else {
                                task.status = 'completed';
                            }
                            if (this.file) {
                                await this.app.vault.modify(this.file, yaml.dump(this.yamlData));
                            }
                            this.renderLeftPanel();
                        });

                        const hoursStr = task.estimated_hours ? `[${task.estimated_hours}h] ` : '';
                        const textSpan = li.createEl('span', { attr: { style: `opacity: ${opacity}; text-decoration: ${textDecoration}; color: var(--text-normal); line-height: 1.4;` } });
                        textSpan.innerHTML = `${hoursStr}${task.title}${timeString}`;

                        if ((task.status === 'scheduled' || task.status === 'partial') && this.calendar) {
                            li.addEventListener('mouseenter', () => {
                                li.style.backgroundColor = 'var(--background-modifier-hover)';
                                const taskEvents = this.yamlData.events?.filter((e: any) => e.type === 'task' && (e.taskId === task.id || e.id === task.id)) || [];
                                taskEvents.forEach((ev: any) => {
                                    const eventObj = this.calendar.getEventById(ev.id);
                                    if (eventObj) {
                                        eventObj.setProp('borderColor', 'var(--text-error)');
                                        eventObj.setProp('backgroundColor', 'var(--interactive-accent-hover)');
                                    }
                                });
                            });
                            li.addEventListener('mouseleave', () => {
                                li.style.backgroundColor = 'transparent';
                                const taskEvents = this.yamlData.events?.filter((e: any) => e.type === 'task' && (e.taskId === task.id || e.id === task.id)) || [];
                                taskEvents.forEach((ev: any) => {
                                    const eventObj = this.calendar.getEventById(ev.id);
                                    if (eventObj) {
                                        const origColor = ev.color || '#3b82f6';
                                        eventObj.setProp('borderColor', origColor);
                                        eventObj.setProp('backgroundColor', origColor);
                                    }
                                });
                            });
                        }
                    });
                }
            });
        }

        this.draggable = new Draggable(this.leftPanelEl, {
            itemSelector: '.fc-event-draggable',
            eventData: function (eventEl) {
                const taskId = eventEl.getAttribute('data-id');
                return {
                    id: taskId + '_' + Date.now().toString(),
                    title: eventEl.getAttribute('data-title'),
                    duration: eventEl.getAttribute('data-duration'),
                    backgroundColor: '#10b981',
                    borderColor: '#10b981',
                    extendedProps: { type: 'task', taskId: taskId }
                };
            }
        });
    }

    clear() {
        this.yamlData = { insight: "", goals: [], events: [] };
        if (this.calendar) this.calendar.removeAllEvents();
        if (this.leftPanelEl) this.leftPanelEl.empty();
    }
}

export default class WeekplanPlugin extends Plugin {
    settings!: MyPluginSettings;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new SampleSettingTab(this.app, this));

        this.registerView(WEEKPLAN_VIEW_TYPE, (leaf) => new WeekplanView(leaf));
        this.registerExtensions(['weekplan'], WEEKPLAN_VIEW_TYPE);

        this.addCommand({
            id: 'create-weekplan',
            name: '今週の作戦会議ファイルを作成',
            callback: async () => {
                const fileName = `2026-W08.weekplan`;
                const fileContent = `week: "2026-W08"\ninsight: |\n  ここに石の配置の考え方や方針が記録されます。\ngoals:\n  - role: "サンプル役割"\n    items:\n      - id: "task-1"\n        title: "サンプルのタスク"\n        estimated_hours: 1.0\n        status: "pool"\nevents: []\n`;
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

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}