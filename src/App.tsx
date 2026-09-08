import { useEffect, useRef, useState, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import petImg from './assets/pet.png';
import { usePetStore } from './store/petStore';
import { useChatStore } from './store/chatStore';
import ChatPanel from './components/ChatPanel';

const App = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ hunger: 80, mood: 80, energy: 80, affection: 50 });
  const [chatOpen, setChatOpen] = useState(false);

  const { hunger, mood, energy, affection, feed, play, rest, decay } = usePetStore();
  const { triggerGreeting } = useChatStore();

  useEffect(() => {
    stateRef.current = { hunger, mood, energy, affection };
    // Sync pet state to main process for LLM context
    window.electronAPI.pet.stateUpdate({ hunger, mood, energy, affection });
  }, [hunger, mood, energy, affection]);

  // Handle proactive greeting trigger from main process (8.4)
  useEffect(() => {
    const cleanup = window.electronAPI.onGreetingTrigger(() => {
      if (!chatOpen) {
        handleToggleChat(true);
      }
      triggerGreeting();
    });
    return cleanup;
  }, [chatOpen, triggerGreeting]);

  const handleToggleChat = useCallback(async (open: boolean) => {
    await window.electronAPI.window.toggleChat(open);
    setChatOpen(open);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let app: PIXI.Application | null = null;
    let isCancelled = false;
    let pet: PIXI.Sprite | null = null;

    const initPixi = async () => {
      const newApp = new PIXI.Application();
      await newApp.init({
        width: 300,
        height: 300,
        backgroundAlpha: 0,
        antialias: true,
      });

      if (isCancelled) {
        newApp.destroy(true);
        return;
      }

      app = newApp;
      container.appendChild(app.canvas as HTMLCanvasElement);
      app.canvas.style.pointerEvents = 'none';

      const texture = await PIXI.Assets.load(petImg);
      pet = new PIXI.Sprite(texture);
      pet.anchor.set(0.5);
      pet.x = 150;
      pet.y = 150;
      pet.scale.set(0.8);
      app.stage.addChild(pet);

      app.ticker.add(() => {
        if (!pet) return;
        const { energy, mood, hunger } = stateRef.current;
        const floatAmplitude = 10 + (energy / 100) * 15;
        const floatSpeed = 0.5 + (energy / 100) * 1.5;
        pet.y = 150 + Math.sin(Date.now() / (1000 / floatSpeed)) * floatAmplitude;
        pet.rotation = mood > 70 ? Math.sin(Date.now() / 800) * 0.1 : 0;
        pet.tint = hunger < 30 ? 0xaaaaaa : 0xffffff;
      });
    };

    initPixi();

    const decayInterval = setInterval(() => {
      decay();
    }, 5000);

    return () => {
      isCancelled = true;
      clearInterval(decayInterval);
      if (app) app.destroy(true);
    };
  }, []);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        background: 'transparent',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Chat Panel (left side, shown when chat is open) */}
      {chatOpen && <ChatPanel onClose={() => handleToggleChat(false)} />}

      {/* Pet Area (right side, always visible) */}
      <div
        ref={containerRef}
        style={{
          width: 300,
          height: '100%',
          position: 'relative',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {/* Drag region */}
        <div
          style={{
            position: 'absolute',
            left: 50,
            top: 50,
            width: 200,
            height: 200,
            WebkitAppRegion: 'drag',
            zIndex: 1,
          }}
        />

        {/* Status display */}
        <div style={statusStyle}>
          饱:{Math.round(hunger)} 心:{Math.round(mood)} 精:{Math.round(energy)} 好:{Math.round(affection)}
        </div>

        {/* Chat toggle button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleToggleChat(!chatOpen);
          }}
          style={{
            ...btnBaseStyle,
            bottom: 60,
            right: 5,
          }}
        >
          {chatOpen ? '收' : '聊'}
        </button>

        {/* Action buttons */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            feed();
          }}
          style={{ ...btnBaseStyle, bottom: 20, right: 5 }}
        >
          喂食
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            rest();
          }}
          style={{ ...btnBaseStyle, bottom: 40, right: 5 }}
        >
          休息
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            play();
          }}
          style={{ ...btnBaseStyle, bottom: 0, right: 5 }}
        >
          玩耍
        </button>
      </div>
    </div>
  );
};

const statusStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 5,
  left: 5,
  fontSize: '10px',
  color: 'white',
  background: 'rgba(0,0,0,0.5)',
  padding: '2px 5px',
  borderRadius: '3px',
  pointerEvents: 'none',
  zIndex: 20,
};

const btnBaseStyle: React.CSSProperties = {
  position: 'absolute',
  opacity: 0.8,
  fontSize: '12px',
  zIndex: 20,
  pointerEvents: 'auto',
  WebkitAppRegion: 'no-drag',
  padding: '2px 6px',
  border: '1px solid rgba(255,255,255,0.3)',
  borderRadius: '4px',
  background: 'rgba(0,0,0,0.6)',
  color: 'white',
  cursor: 'pointer',
};

export default App;
