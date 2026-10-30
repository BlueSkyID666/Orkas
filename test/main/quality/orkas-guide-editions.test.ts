import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const skillRoot = path.resolve(process.cwd(), 'resources/builtin/system/skills');
const guideRoot = path.join(skillRoot, 'orkas-guide');
const read = (file: string) => fs.readFileSync(path.join(guideRoot, file), 'utf8');

describe('shared Orkas guide editions', () => {
  it('ships one registered guide whose references remain readable in either build', () => {
    const rows = JSON.parse(fs.readFileSync(path.join(skillRoot, '_system.json'), 'utf8'));
    expect(rows.filter((row: { id: string }) => row.id === 'orkas-guide')).toEqual([
      { id: 'orkas-guide', update_at: expect.any(Number) },
    ]);
    const root = read('SKILL.md');
    expect(root).toContain('name: orkas-guide');
    expect(root).toMatch(/commercial and open-source editions/i);
    expect(root).toMatch(/commercial edition only[^\n]*paid membership/i);
    for (const [, reference] of root.matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)) {
      expect(reference).not.toContain('..');
      expect(read(reference).trim(), reference).not.toBe('');
    }
    expect(root).toContain('(references/editions.md)');
  });

  it('separates commercial account features from local and user-owned provider access', () => {
    const editions = read('references/editions.md');
    for (const fact of ['cloud sync', 'collaboration', 'public share links', 'publication', 'automatic updates', 'iOS']) {
      expect(editions.toLowerCase(), fact).toContain(fact.toLowerCase());
    }
    expect(editions).toContain('provider OAuth');
    expect(editions).toContain('Orkas API Key');
    expect(editions).toMatch(/local[^\n]*Projects[^\n]*To-do[^\n]*Automation/i);
    expect(editions).toMatch(/no Account\/Plan\/credits page/);
    expect(editions).toContain('Settings > Models');
    expect(editions).toContain('Settings > Data');
    expect(editions).toContain('Settings > General');
  });

  it('labels hosted workflows at their owning sections', () => {
    for (const [file, section] of [
      ['projects-and-automation.md', 'Share a Project with members'],
      ['tasks-and-conversations.md', 'Share messages and results'],
      ['library-search-and-apps.md', 'Publish an app'],
      ['settings-data-and-safety.md', 'Credits'],
      ['settings-data-and-safety.md', 'Membership'],
      ['settings-data-and-safety.md', 'Sync and cloud data'],
    ]) expect(read(`references/${file}`)).toMatch(new RegExp(`## ${section}[^\\n]*commercial edition only`, 'i'));
  });
});
