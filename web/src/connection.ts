import { useEffect } from 'react';
import { MOCK, fetchState, setActionHandler, setLeaderboardHandler, wsUrl } from './api';
import { useArcade } from './store';
import type { Message } from './types';

/** Connects the store to the arcade-server WebSocket (or the in-browser mock). */
export function useArcadeConnection() {
  const setWorld = useArcade((s) => s.setWorld);
  const setPet = useArcade((s) => s.setPet);
  const setScenario = useArcade((s) => s.setScenario);
  const setConnected = useArcade((s) => s.setConnected);
  const toast = useArcade((s) => s.toast);

  useEffect(() => {
    const handle = (m: Message) => {
      switch (m.type) {
        case 'snapshot':
          setWorld(m.state);
          break;
        case 'pet':
          setPet(m.pet);
          break;
        case 'scenario':
          setScenario(m.scenario);
          break;
        case 'toast':
          toast(m.level, m.text);
          break;
      }
    };

    if (MOCK) {
      let dispose = () => {};
      void import('./mock/server').then(({ mockServer }) => {
        const srv = mockServer();
        setActionHandler(srv.action);
        setLeaderboardHandler({ get: srv.getLeaderboard, post: srv.postLeaderboard });
        dispose = srv.subscribe(handle);
        setConnected(true);
      });
      return () => dispose();
    }

    let ws: WebSocket | undefined;
    let closed = false;
    let retry = 1000;
    let timer: number | undefined;

    const connect = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        setConnected(true);
        retry = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          handle(JSON.parse(ev.data as string) as Message);
        } catch (e) {
          console.warn('bad ws message', e);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 10_000);
      };
      ws.onerror = () => ws?.close();
    };
    // Prime with a REST snapshot so the lobby renders even before the socket is up.
    fetchState()
      .then(setWorld)
      .catch(() => {});
    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      ws?.close();
    };
  }, [setWorld, setPet, setScenario, setConnected, toast]);
}
