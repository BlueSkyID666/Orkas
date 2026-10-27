import { expect, test } from './fixtures/orkas';

declare const _settingsState: {
  orkasApiCredential: { configured: boolean; keyMasked: string };
};
declare function _settingsRenderOrkasApiCard(): void;

async function openSettingsTab(page: import('@playwright/test').Page, tabName: string): Promise<void> {
  await page.locator('#settings-btn').click();
  const tab = page.locator(`.settings-tab[data-settings-tab="${tabName}"]`);
  await tab.click();
  await expect(tab).toHaveClass(/\bis-active\b/);
  await expect(page.locator(`[data-settings-pane="${tabName}"]`)).toBeVisible();
}

// Since the settings redesign the provider / model pickers live in the
// "+ 添加模型" dialog (#settings-add-modal) instead of inline on the Models tab.
async function openAddModelDialog(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-settings-add="chat"]').click();
  await expect(page.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#settings-add-modal [data-settings-add-form="chat"]')).toBeVisible();
}

test.describe('settings modules and model guard', () => {
  test('keeps model savings readable beside the API-key title across languages and widths', async ({ appPage }, testInfo) => {
    await openSettingsTab(appPage, 'credentials');
    const card = appPage.locator('#settings-orkas-api-group');
    const saving = card.locator('[data-i18n="price_comparison.maximum"]');
    await expect(saving).toHaveText('Model costs up to 50% less than provider API pricing');
    await expect(card.locator('#settings-orkas-api-key-input')).toBeVisible();
    // A masked presentation fixture never saves or transmits a credential.
    await appPage.evaluate(() => {
      _settingsState.orkasApiCredential = { configured: true, keyMasked: 'sk-demo…1234' };
      _settingsRenderOrkasApiCard();
    });
    for (const [language, width] of [['en', 1280], ['zh', 1280], ['zh', 620], ['de', 620], ['ar', 620]] as const) {
      await appPage.setViewportSize({ width, height: 900 });
      await appPage.evaluate(async language => { await (window as any).setLang(language); }, language);
      await expect(saving).toBeVisible();
      if (language === 'zh') {
        await expect(saving).toHaveText('模型费用较厂商 API 最高省 50%');
        await expect(card.locator('[data-i18n="settings.orkas_api.sub"]'))
          .toHaveText('统一用于 Orkas 模型、搜索、图片、语音、视频和需要积分的连接器。密钥仅加密保存在本机。');
      }
      const geometry = await saving.evaluate(element => {
        const box = element.getBoundingClientRect();
        const card = element.closest('#settings-orkas-api-group')!;
        const bounds = card.getBoundingClientRect();
        return {
          containsLabel: box.left >= bounds.left && box.right <= bounds.right,
          noClip: element.scrollWidth <= element.clientWidth + 1,
          noCardOverflow: card.scrollWidth <= card.clientWidth + 1,
        };
      });
      expect(geometry).toEqual({ containsLabel: true, noClip: true, noCardOverflow: true });
      if (width === 620) {
        const copy = (await card.locator('.settings-group-head-main').boundingBox())!;
        const create = (await card.locator('#settings-orkas-api-create-key').boundingBox())!;
        expect(create.y).toBeGreaterThanOrEqual(copy.y + copy.height);
      }
      await expect(card.locator('#settings-orkas-api-key-masked')).toHaveText('sk-demo…1234');
      await expect(card.locator('#settings-orkas-api-edit')).toBeVisible();
      await expect(card.locator('#settings-orkas-api-delete')).toBeVisible();
      await card.screenshot({ path: testInfo.outputPath(`api-key-${language}-${width}.png`) });
    }
    await card.locator('#settings-orkas-api-edit').click();
    await expect(card.locator('#settings-orkas-api-key-input')).toBeVisible();
    await expect(card.locator('#settings-orkas-api-key-input')).toHaveValue('');
    await card.locator('#settings-orkas-api-cancel').click();
    await expect(card.locator('#settings-orkas-api-key-input')).toBeHidden();
  });

  test('Escape closes the model picker before the dialog and returns focus to Add', async ({ appPage }) => {
    await openSettingsTab(appPage, 'credentials');
    await openAddModelDialog(appPage);
    const trigger = appPage.locator('#settings-picker-provider .ai-select-trigger');
    await trigger.click();
    await expect(appPage.locator('.ai-select-popover:visible')).toBeVisible();
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('.ai-select-popover:visible')).toHaveCount(0);
    await expect(appPage.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
    await expect(appPage.locator('[data-settings-add="chat"]')).toBeFocused();
  });

  test('renders data, recycle bin, and BYO credential settings', async ({ appPage }, testInfo) => {
    await openSettingsTab(appPage, 'data');
    await expect(appPage.locator('#settings-data-root-btn')).toBeVisible();
    await expect(appPage.locator('#settings-recycle-group')).toBeVisible();
    await expect(appPage.locator('#settings-recycle-body')).toBeVisible();
    const recycleViewport = appPage.locator('#settings-recycle-body .settings-recycle-scroll');
    await expect(recycleViewport).toBeVisible();
    await expect(recycleViewport).toHaveAttribute('data-recycle-source', 'local');
    await expect(appPage.locator('#settings-recycle-body [data-recycle-tab]')).toHaveCount(0);
    const recycleLayout = await recycleViewport.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflowY: style.overflowY, maxHeight: Number.parseFloat(style.maxHeight) };
    });
    expect(recycleLayout.overflowY).toBe('auto');
    expect(recycleLayout.maxHeight).toBeGreaterThan(0);
    expect(recycleLayout.maxHeight).toBeLessThanOrEqual(320);

    await openSettingsTab(appPage, 'credentials');
    await expect(appPage.locator('[data-settings-add="chat"]')).toBeVisible();
    await expect(appPage.locator('#settings-entries .entry-row', {
      hasText: 'E2E-Local-Model',
    })).toBeVisible();
    await expect(appPage.locator('#settings-entries .settings-empty')).toHaveCount(0);
    const sort = appPage.locator('#settings-entries .entry-row').first().locator('.entry-sort');
    await expect(sort).toHaveCSS('display', 'flex');
    await expect(sort).toHaveCSS('flex-direction', 'column');
    await expect(sort.locator('button').first()).toHaveCSS('border-top-width', '0px');
    await appPage.screenshot({ path: testInfo.outputPath('settings-model-sort-actions.png') });
    await openAddModelDialog(appPage);
    await expect(appPage.locator('#settings-add-entry-btn')).toBeVisible();
    await appPage.locator('#settings-add-entry-btn').click();
    await expect(appPage.locator('#settings-picker-status')).not.toHaveText('');
    await expect(appPage.locator('#settings-add-modal')).toHaveClass(/\bopen\b/);
    await appPage.locator('#settings-add-modal [data-settings-add-cancel]:visible').click();
    await expect(appPage.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
  });

  test('persists a masked model credential entry and removes it from the UI', async ({ orkas }) => {
    if (!orkas.page) throw new Error('Orkas renderer is unavailable');
    await openSettingsTab(orkas.page, 'credentials');
    await openAddModelDialog(orkas.page);
    await orkas.page.locator('#settings-picker-provider .ai-select-trigger').click();
    let popover = orkas.page.locator('.ai-select-popover:visible');
    await popover.locator('.ai-select-item', { hasText: 'Anthropic' }).click();
    await orkas.page.locator('#settings-picker-model .ai-select-trigger').click();
    popover = orkas.page.locator('.ai-select-popover:visible');
    await expect(popover.locator('.ai-select-item').first()).toBeVisible();
    await popover.locator('.ai-select-item').first().click();
    await orkas.page.locator('#settings-add-entry-btn').click();
    // The picker dialog hands over to the credential dialog; they never stack.
    await expect(orkas.page.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
    await orkas.page.locator('#add-account-modal .method-tile[data-method="api_key"]').click();
    await expect(orkas.page.locator('#add-account-modal .api-key-input')).toHaveAttribute('type', 'password');
    await orkas.page.locator('#add-account-modal .api-label-input').fill('E2E Model Account');
    await orkas.page.locator('#add-account-modal .api-key-input').fill('sk-e2e-placeholder-xxxxxxxx');
    await orkas.page.locator('#add-account-actions .btn-primary').click();

    let row = orkas.page.locator('#settings-entries .entry-row', { hasText: 'E2E-Model-Account' });
    await expect(row).toContainText('Anthropic');
    await expect(row).toContainText('E2E-Model-Account');
    await expect(row).not.toContainText('sk-e2e-placeholder-xxxxxxxx');
    const entryId = await row.getAttribute('data-entry-id');
    expect(entryId).toBeTruthy();

    const relaunchedPage = await orkas.relaunch();
    await openSettingsTab(relaunchedPage, 'credentials');
    row = relaunchedPage.locator(`.entry-row[data-entry-id="${entryId}"]`);
    await expect(row).toBeVisible();
    await row.locator('.entry-actions .danger').click();
    await expect(relaunchedPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
    await expect(row).toHaveCount(0);
    await expect(relaunchedPage.locator('#settings-entries .entry-row', {
      hasText: 'E2E-Local-Model',
    })).toBeVisible();
  });

  for (const protocol of ['openai', 'anthropic'] as const) {
    test(`configures a custom ${protocol} model without revealing its endpoint or key`, async ({ orkas }) => {
      if (!orkas.page) throw new Error('Orkas renderer is unavailable');
      const beforeSave = await orkas.invoke<{
        entries: Array<{ entryId: string; provider: string }>;
      }>('auth.listEntries', { includeUnavailable: true });
      const beforeCustomIds = beforeSave.entries
        .filter((entry) => entry.provider === 'custom')
        .map((entry) => entry.entryId)
        .sort();
      await openSettingsTab(orkas.page, 'credentials');
      await openAddModelDialog(orkas.page);
      await orkas.page.locator('#settings-picker-provider .ai-select-trigger').click();
      const popover = orkas.page.locator('.ai-select-popover:visible');
      await popover.locator('.ai-select-item', { hasText: 'Custom' }).click();
      await expect(orkas.page.locator('#settings-picker-model-row')).toBeHidden();
      await orkas.page.locator('#settings-add-entry-btn').click();

      const modal = orkas.page.locator('#add-account-modal');
      await expect(modal).toHaveClass(/\bopen\b/);
      await expect(orkas.page.locator('#settings-add-modal')).not.toHaveClass(/\bopen\b/);
      await expect(modal.locator('.custom-key-input')).toHaveAttribute('type', 'password');
      const protocolPicker = modal.locator('.custom-protocol-input');
      const protocolTrigger = protocolPicker.getByRole('combobox', { name: 'Protocol', exact: true });
      await expect(protocolPicker).toHaveAttribute('data-value', 'openai');
      await expect(protocolTrigger).toHaveText('OpenAI-compatible');
      await protocolTrigger.click();
      const protocolMenu = orkas.page.locator('.ai-select-popover:visible');
      await expect(protocolMenu.getByRole('option', { name: 'Anthropic-compatible', exact: true })).toBeVisible();
      await test.info().attach('custom-protocol-menu', {
        body: await modal.screenshot(), contentType: 'image/png',
      });
      await orkas.page.keyboard.press('Escape');
      await expect(protocolMenu).toHaveCount(0);
      await expect(modal).toHaveClass(/\bopen\b/);
      await protocolTrigger.click();
      if (protocol === 'anthropic') {
        const option = protocolMenu.getByRole('option', { name: 'Anthropic-compatible', exact: true });
        const optionId = await option.getAttribute('id');
        for (let index = 0; index < await protocolMenu.getByRole('option').count(); index += 1) {
          if (await protocolTrigger.getAttribute('aria-activedescendant') === optionId) break;
          await orkas.page.keyboard.press('ArrowDown');
        }
        await expect(protocolTrigger).toHaveAttribute('aria-activedescendant', optionId!);
      }
      await orkas.page.keyboard.press('Enter');
      await expect(protocolMenu).toHaveCount(0);
      await expect(protocolPicker).toHaveAttribute('data-value', protocol);
      await expect(protocolTrigger).toHaveText(protocol === 'anthropic'
        ? 'Anthropic-compatible' : 'OpenAI-compatible');
      await orkas.page.keyboard.press('Tab');
      await expect(modal.locator('.custom-base-url-input')).toBeFocused();
      await expect(modal.locator('.custom-base-url-input')).toHaveAttribute('placeholder',
        protocol === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1');
      await modal.locator('.custom-label-input').fill('E2E Private Gateway');
      await modal.locator('.custom-base-url-input').fill(
        'https://embedded:credential@gateway.example.invalid/v1',
      );
      await modal.locator('.custom-model-input').fill('acme/private-reasoner');
      await modal.locator('.custom-key-input').fill('sk-custom-e2e-secret-xxxxxxxx');
      await orkas.page.locator('#add-account-actions .btn-primary').click();
      await expect(modal.locator('.form-msg')).toHaveClass(/\berror\b/);
      await expect(modal.locator('.form-msg')).not.toBeEmpty();
      await expect(modal).toHaveClass(/\bopen\b/);
      const afterRejectedSave = await orkas.invoke<{
        entries: Array<{ entryId: string; provider: string }>;
      }>('auth.listEntries', { includeUnavailable: true });
      expect(afterRejectedSave.entries
        .filter((entry) => entry.provider === 'custom')
        .map((entry) => entry.entryId)
        .sort()).toEqual(beforeCustomIds);

      await modal.locator('.custom-base-url-input').fill(
        protocol === 'anthropic' ? 'https://gateway.example.invalid/proxy/v1/v1/messages'
          : 'https://gateway.example.invalid/v1/chat/completions',
      );
      await orkas.page.locator('#add-account-actions .btn-primary').click();

      let row = orkas.page.locator('#settings-entries .entry-row', {
        hasText: 'acme/private-reasoner',
      });
      await expect(row).toContainText('Custom');
      await expect(row).toContainText('E2E-Private-Gateway');
      await expect(row).not.toContainText('sk-custom-e2e-secret-xxxxxxxx');
      await expect(row).not.toContainText('gateway.example.invalid');
      const entryId = await row.getAttribute('data-entry-id');
      expect(entryId).toBeTruthy();

      const listed = await orkas.invoke<{
        entries: Array<Record<string, unknown>>;
      }>('auth.listEntries', { includeUnavailable: true });
      const customEntry = listed.entries.find((entry) => entry.entryId === entryId);
      expect(customEntry).toMatchObject({
        provider: 'custom',
        model: 'acme/private-reasoner',
        profileLabel: 'E2E-Private-Gateway',
      });
      expect(customEntry).not.toHaveProperty('apiKey');
      expect(customEntry).not.toHaveProperty('baseUrl');

      const relaunchedPage = await orkas.relaunch();
      await openSettingsTab(relaunchedPage, 'credentials');
      row = relaunchedPage.locator(`.entry-row[data-entry-id="${entryId}"]`);
      await expect(row).toContainText('acme/private-reasoner');
      const storedRuntime = await orkas.electronApp!.evaluate(async () => {
        const auth = (process as any).mainModule.require(process.cwd() + '/src/main/features/auth.ts');
        const choices = await auth.pickChatEntryGroup();
        const choice = choices.find((value: { model: string }) => value.model === 'acme/private-reasoner');
        return { protocol: choice?.customConfig?.protocol, baseUrl: choice?.customConfig?.baseUrl };
      });
      expect(storedRuntime).toEqual({ protocol, baseUrl: protocol === 'anthropic'
        ? 'https://gateway.example.invalid/proxy/v1' : 'https://gateway.example.invalid/v1' });

      await expect(row).not.toContainText('gateway.example.invalid');
      await row.locator('.entry-actions .danger').click();
      await relaunchedPage.locator('.ui-dialog-overlay:visible [data-act="ok"]').click();
      await expect(row).toHaveCount(0);
    });

  }

  test('keeps an empty model state quiet until an LLM action needs configuration', async ({ appPage, orkas }) => {
    const listed = await orkas.invoke<{
      entries: Array<{ entryId: string }>;
    }>('auth.listEntries');
    for (const entry of listed.entries) {
      const removed = await orkas.invoke<{ ok: boolean; removed: boolean }>('auth.removeEntry', {
        entryId: entry.entryId,
      });
      expect(removed).toMatchObject({ ok: true, removed: true });
    }

    const silentResult = await appPage.evaluate(async () => {
      await (window as any).refreshModelGuard();
      return (window as any).ensureModelConfigured({ silent: true });
    });
    expect(silentResult).toBe(false);
    await expect(appPage.locator('#model-guard-banner')).toHaveCount(0);
    await expect(appPage.locator('#panel-new-chat')).toHaveClass(/\bactive\b/);

    await appPage.locator('#new-chat-input').fill('This request needs a configured model.');
    await appPage.locator('#new-chat-send-btn').click();

    await expect(appPage.locator('#panel-settings')).toHaveClass(/\bactive\b/);
    await expect(appPage.locator('.settings-tab[data-settings-tab="credentials"]')).toHaveClass(/\bis-active\b/);
    await expect(appPage.locator('.ui-dialog-overlay:visible .ui-dialog')).toBeVisible();
    await expect(appPage.locator('#conversation-list .conv-item')).toHaveCount(0);
  });

});
