import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StartupUpdatePrompt, startupUpdateVersion } from './StartupUpdatePrompt';

describe('startup update prompt', () => {
  it('offers only an update discovered by the startup check', () => {
    expect(startupUpdateVersion({ phase: 'available', version: '0.1.5', downloaded: 0 })).toBe('0.1.5');
    expect(startupUpdateVersion({ phase: 'current', downloaded: 0 })).toBeNull();
    expect(startupUpdateVersion({ phase: 'error', downloaded: 0 })).toBeNull();
  });

  it('asks whether to install a newly discovered version', () => {
    const html = renderToStaticMarkup(<StartupUpdatePrompt
      currentVersion="0.1.4"
      version="0.1.5"
      notes="Update notes"
      conversationActive={false}
      onLater={() => undefined}
      onInstall={() => undefined}
    />);

    expect(html).toContain('アップデートがあります');
    expect(html).toContain('0.1.4');
    expect(html).toContain('0.1.5');
    expect(html).toContain('後で');
    expect(html).toContain('今すぐアップデート');
    expect(html).not.toContain('disabled=""');
  });

  it('blocks installation while a conversation is active', () => {
    const html = renderToStaticMarkup(<StartupUpdatePrompt
      version="0.1.5"
      conversationActive
      onLater={() => undefined}
      onInstall={() => undefined}
    />);

    expect(html).toContain('会話を終了してからアップデートしてください。');
    expect(html).toContain('disabled=""');
  });
});
