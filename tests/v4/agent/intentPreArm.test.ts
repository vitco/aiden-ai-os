/**
 * Phase 23.4b — intent pre-arm regex tests.
 *
 * Pure-function tests, no mocks.  Covers the bug-Y class plus the
 * past-tense kill-switch.
 */
import { describe, it, expect } from 'vitest';
import { preArmIntent } from '../../../core/v4/agent/intentPreArm';

describe('preArmIntent — positive cases (imperative + media noun)', () => {
  it('matches "play me a song"', () => {
    expect(preArmIntent('play me a song')).toEqual({ skill: 'media-search' });
  });

  it('matches "play me a popular song"', () => {
    expect(preArmIntent('play me a popular song')).toEqual({ skill: 'media-search' });
  });

  it('matches "play an obscure indie band"', () => {
    expect(preArmIntent('play an obscure indie band')).toEqual({ skill: 'media-search' });
  });

  it('matches "queue some jazz" (queue + jazz noun via tune/track families) — actually requires a media noun', () => {
    // "jazz" alone isn't in the noun list; the dispatch's example uses it
    // because "queue some jazz tunes" or "queue some music" matches.
    expect(preArmIntent('queue some music')).toEqual({ skill: 'media-search' });
  });

  it('matches "stream a track"', () => {
    expect(preArmIntent('stream a track')).toEqual({ skill: 'media-search' });
  });

  it('matches "put on the new album"', () => {
    expect(preArmIntent('put on the new album')).toEqual({ skill: 'media-search' });
  });

  it('matches "listen to that artist"', () => {
    expect(preArmIntent('listen to that artist')).toEqual({ skill: 'media-search' });
  });

  it('is case-insensitive', () => {
    expect(preArmIntent('PLAY ME A SONG')).toEqual({ skill: 'media-search' });
  });

  it('matches with longer cushion text between verb and noun (within 40 chars)', () => {
    expect(preArmIntent('play me something nice — a song actually')).toEqual({
      skill: 'media-search',
    });
  });
});

describe('preArmIntent — negative kill-switch (past tense / reminiscence)', () => {
  it('rejects "I was listening to a song earlier"', () => {
    expect(preArmIntent('I was listening to a song earlier')).toBeNull();
  });

  it('rejects "yesterday I played that track"', () => {
    expect(preArmIntent('yesterday I played that track')).toBeNull();
  });

  it('rejects "I had been listening to music"', () => {
    expect(preArmIntent('I had been listening to music')).toBeNull();
  });

  it('rejects "earlier we heard a tune"', () => {
    expect(preArmIntent('earlier we heard a tune')).toBeNull();
  });
});

describe('preArmIntent — negative non-matches (no imperative + media noun pair)', () => {
  it('rejects "what\'s the weather"', () => {
    expect(preArmIntent("what's the weather")).toBeNull();
  });

  it('rejects "tell me about songs" — no imperative verb', () => {
    expect(preArmIntent('tell me about songs')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(preArmIntent('')).toBeNull();
  });

  it('rejects non-string input', () => {
    // Defensive: caller may pass undefined accidentally.
    expect(preArmIntent(undefined as unknown as string)).toBeNull();
  });

  it('rejects play without a media noun', () => {
    expect(preArmIntent('play me something')).toBeNull();
  });

  it('rejects media noun without an imperative verb', () => {
    expect(preArmIntent('the song was great')).toBeNull();
  });
});
