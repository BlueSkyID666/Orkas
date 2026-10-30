import { expect, test } from './fixtures/orkas';

for (const language of ['en', 'zh']) {
  test(`browser status distinguishes available, reading, acting and waiting (${language})`, async ({ orkas }, info) => {
    const page = orkas.page!;
    await page.setViewportSize({ width: language === 'en' ? 1280 : 1000, height: 800 });
    await page.evaluate(lang => (window as any).setLang(lang), language);
    const { conversation } = await orkas.invoke<any>('conversations.create', { title: 'Browser activity states' });
    const cid = conversation.conversation_id;
    await page.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser', id);
    }, cid);
    const opened = await orkas.invoke<any>('webAssist.addTab', { conversationId: cid });
    expect(opened.ok).toBe(true);
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
    const { state } = await orkas.invoke<any>('webAssist.state');
    const expected = language === 'zh'
      ? ['AI 可操作此页面', 'AI 正在读取此页面…', 'AI 正在操作此页面…', 'AI 正在等待页面变化…']
      : ['AI can operate this page', 'AI is reading this page…', 'AI is operating this page…', 'AI is waiting for the page to change…'];
    // Drive the existing main-to-renderer state boundary over a real browser
    // tab. No model call or permission inference is part of this copy change.
    for (const [index, action] of ['', 'observing', 'acting', 'waiting'].entries()) {
      await orkas.electronApp!.evaluate(({ BrowserWindow }, input) => {
        const owner = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/renderer/index.html'))!;
        owner.webContents.send('web-assist:state', { ...input.state, assistant_action: input.action,
          tabs: input.state.tabs.map((tab: any) => ({ ...tab, loading: false, suspended: false,
            user_controlled: false, assistant_controlled: true, assistant_action: input.action })) });
      }, { state, action });
      await expect(page.locator('.web-assist-status')).toHaveText(expected[index]);
      await page.screenshot({ path: info.outputPath(`browser-status-${language}-${index}.png`) });
    }
    expect(orkas.modelRequests).toHaveLength(0);
  });
}
