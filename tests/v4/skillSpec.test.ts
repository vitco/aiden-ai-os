import { describe, it, expect } from 'vitest';
import {
  parseSkillContent,
  serializeSkill,
  looksLikeSkill,
} from '../../core/v4/skillSpec';

const minimal = `---
name: hello
description: A friendly skill.
version: 1.0.0
---

# Hello
Body text here.
`;

describe('skillSpec', () => {
  it('1. parses a valid SKILL.md', () => {
    const r = parseSkillContent(minimal);
    expect(r.frontmatter.name).toBe('hello');
    expect(r.frontmatter.version).toBe('1.0.0');
    expect(r.body).toMatch(/Hello/);
  });

  it('2. throws when name is missing', () => {
    const bad = minimal.replace('name: hello\n', '');
    expect(() => parseSkillContent(bad)).toThrow(/required field "name"/);
  });

  it('3. throws when description is missing', () => {
    const bad = minimal.replace('description: A friendly skill.\n', '');
    expect(() => parseSkillContent(bad)).toThrow(/required field "description"/);
  });

  it('4. throws when version is missing', () => {
    const bad = minimal.replace('version: 1.0.0\n', '');
    expect(() => parseSkillContent(bad)).toThrow(/required field "version"/);
  });

  it('5. handles missing optional metadata', () => {
    const r = parseSkillContent(minimal);
    expect(r.frontmatter.metadata).toBeUndefined();
    expect(r.frontmatter.tags).toBeUndefined();
  });

  it('6. round-trip serialize → parse preserves data', () => {
    const r = parseSkillContent(minimal);
    const text = serializeSkill(r);
    const r2 = parseSkillContent(text);
    expect(r2.frontmatter.name).toBe(r.frontmatter.name);
    expect(r2.body.trim()).toBe(r.body.trim());
  });

  it('7. body extracted correctly with multi-line content', () => {
    const skill = `---
name: multi
description: x
version: 1
---

Line 1
Line 2

Line 4
`;
    const r = parseSkillContent(skill);
    expect(r.body).toContain('Line 1');
    expect(r.body).toContain('Line 4');
  });

  it('8. accepts multi-line frontmatter values', () => {
    const skill = `---
name: deep
description: |
  Multi-line
  description text
version: 2
metadata:
  aiden:
    tags: [a, b, c]
    config:
      - key: api_key
        prompt: Enter key
---
body
`;
    const r = parseSkillContent(skill);
    expect(r.frontmatter.description).toMatch(/Multi-line/);
    expect(r.frontmatter.metadata?.aiden?.tags).toEqual(['a', 'b', 'c']);
    expect(r.frontmatter.metadata?.aiden?.config?.[0].key).toBe('api_key');
  });

  it('9. coerces integer version to string (v3 compat)', () => {
    const skill = `---
name: legacy
description: legacy v3 skill
version: 1
---
body
`;
    const r = parseSkillContent(skill);
    expect(r.frontmatter.version).toBe('1');
  });

  it('10. throws on missing frontmatter block', () => {
    expect(() => parseSkillContent('# just markdown')).toThrow(/no frontmatter/);
  });

  it('11. throws on malformed YAML', () => {
    const skill = `---
name: bad
description: x
version: 1
unclosed: [
---
body`;
    expect(() => parseSkillContent(skill)).toThrow(/Malformed YAML/);
  });

  it('12. handles unicode content + BOM', () => {
    const skill = `﻿---
name: 日本語
description: ユニコード
version: 1.0
---
本文
`;
    const r = parseSkillContent(skill);
    expect(r.frontmatter.name).toBe('日本語');
    expect(r.body.trim()).toBe('本文');
  });

  it('13. looksLikeSkill correctly classifies', () => {
    expect(looksLikeSkill(minimal)).toBe(true);
    expect(looksLikeSkill('# just markdown')).toBe(false);
    expect(looksLikeSkill('')).toBe(false);
  });
});
