import { Plugin, WorkspaceLeaf, TextFileView, Notice } from 'obsidian';
import { Calendar } from '@fullcalendar/core';
import timeGridPlugin from '@fullcalendar/timegrid';
import * as yaml from 'js-yaml';

export const WEEKPLAN_VIEW_TYPE = "weekplan-view";

// --- 独自のビュークラスの定義 ---
export class WeekplanView extends TextFileView {
    calendar: Calendar;
    yamlData: any;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
        this.yamlData = { events: [] };
    }

    // ビューの識別子
    getViewType() {
        return WEEKPLAN_VIEW_TYPE;
    }

    // タブに表示される名前
    getDisplayText() {
        return this.file ? this.file.basename : "Weekplan";
    }

    // ファイルが開かれたときの処理（UIの構築）
    async onOpen() {
        const container = this.contentEl;
        container.empty();
        
        // ヘッダー部分（Step 4でボタンの機能を実装します）
        const header = container.createEl('div', { cls: 'weekplan-header', attr: { style: 'padding: 10px; display: flex; gap: 10px;' } });
        const syncBtn = header.createEl('button', { text: '🔄 Outlook予定を取得 (Stub)' });

        syncBtn.addEventListener('click', async () => {
            new Notice('Outlook予定を取得中...');

            try {
                // Node.jsの標準モジュールをここで直接読み込む（Obsidianプラグインで確実な方法）
                const path = require('path');
                const { exec } = require('child_process');

                // ObsidianのVaultの絶対パスを取得
                const adapter = this.app.vault.adapter as any;
                const vaultPath = adapter.getBasePath();
                
                // Pythonスクリプトの絶対パスを構築
                const scriptPath = path.join(vaultPath, 'stub_fetch.py');
                
                // Mac環境のため python3 コマンドを使用
                const command = `python3 "${scriptPath}"`;

                // Node.jsの機能で裏でPythonを実行
                exec(command, async (error: any, stdout: string, stderr: string) => {
                    if (error) {
                        console.error('Python実行エラー:', error, stderr);
                        new Notice('予定の取得に失敗しました。コンソールを確認してください。');
                        return;
                    }

                    try {
                        // Pythonが吐き出したJSONをパース
                        const newEvents = JSON.parse(stdout);

                        // 現在のYAMLデータ（AIが書いたタスク等）を保持
                        const currentData = this.yamlData || { events: [] };
                        if (!currentData.events) currentData.events = [];

                        // 既存の「Outlookの予定(type: outlook)」だけを削除し、AIのタスクは残す
                        currentData.events = currentData.events.filter((ev: any) => ev.type !== 'outlook');
                        
                        // 新しく取得したOutlook予定を追加
                        currentData.events.push(...newEvents);

                        // YAMLテキストに変換
                        const newYaml = yaml.dump(currentData);

                        // ObsidianのAPIでファイルを上書き保存
                        if (this.file) {
                            await this.app.vault.modify(this.file, newYaml);
                            new Notice('予定を同期しました！');
                        }
                    } catch (e) {
                        console.error('JSONパースエラー:', e);
                        new Notice('データの解析に失敗しました');
                    }
                });
            } catch (err) {
                console.error('モジュール読み込みエラー:', err);
                new Notice('システムエラー: モジュールの読み込みに失敗しました');
            }
        });
        
        // カレンダーを描画するコンテナ
        const calendarEl = container.createEl('div', { cls: 'weekplan-calendar', attr: { style: 'flex-grow: 1; height: 100%;' } });
        
        // コンテナ全体を縦並びのFlexboxにする
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.height = '100%';

        // FullCalendarの初期化
        this.calendar = new Calendar(calendarEl, {
            plugins: [timeGridPlugin],
            initialView: 'timeGridWeek',

            firstDay: 1, // 0:日曜, 1:月曜, 2:火曜... （月曜始まりに設定）
            
            // Y軸（左側）の時間表示を24時間表記に
            slotLabelFormat: {
                hour: 'numeric',
                minute: '2-digit',
                hour12: false
            },
            
            // ブロック内に表示される時間を24時間表記に
            eventTimeFormat: {
                hour: 'numeric',
                minute: '2-digit',
                hour12: false
            },

            headerToolbar: {
                left: 'prev,next',
                center: 'title',
                right: '' // 今回は週ビュー固定なのでシンプルに
            },
            allDaySlot: false,
            slotMinTime: '08:00:00', // 朝8時から表示
            slotMaxTime: '22:00:00', // 夜22時まで表示
            events: []
        });
        
        this.calendar.render();

        // 描画バグを防ぐため、少し待ってからリサイズ処理を入れる
        setTimeout(() => this.calendar.updateSize(), 100);
    }

    // ファイルが閉じられたときの処理
    async onClose() {
        if (this.calendar) {
            this.calendar.destroy();
        }
    }

    // ファイルに保存するデータを返す処理
    getViewData() {
        return yaml.dump(this.yamlData);
    }

    // ファイルが読み込まれた・更新されたときの処理（ここがAI連動のキモ！）
    setViewData(data: string, clear: boolean) {
        try {
            // YAMLテキストをパース
            this.yamlData = yaml.load(data) || { events: [] };
            
            // 現在のカレンダーの予定を一旦すべて消去
            this.calendar.removeAllEvents();
            
            // YAMLのデータをもとにカレンダーに予定を再描画
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
        } catch (e) {
            console.error("YAML parse error:", e);
        }
    }
    
    // エディタをクリアする処理（TextFileViewの必須メソッド）
    clear() {
        this.yamlData = { events: [] };
        if (this.calendar) this.calendar.removeAllEvents();
    }
}

// --- プラグイン本体の定義 ---
export default class WeekplanPlugin extends Plugin {
    async onload() {
        // カスタムビューを登録
        this.registerView(
            WEEKPLAN_VIEW_TYPE,
            (leaf) => new WeekplanView(leaf)
        );

        // .weekplan 拡張子をカスタムビューに関連付け
        this.registerExtensions(['weekplan'], WEEKPLAN_VIEW_TYPE);
        
        // コマンドパレットから空の計画ファイルを作るコマンド
        this.addCommand({
            id: 'create-weekplan',
            name: '今週の作戦会議ファイルを作成',
            callback: async () => {
                const fileName = `2026-W08.weekplan`;
                const fileContent = `week: "2026-W08"\ntarget_hours: 40\nevents:\n`;
                
                // 既にファイルがあるかチェック
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
        // プラグイン無効化時にビューを解除
        this.app.workspace.detachLeavesOfType(WEEKPLAN_VIEW_TYPE);
    }
}
