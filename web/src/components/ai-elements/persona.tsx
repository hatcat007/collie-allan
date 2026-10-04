"use client";

import { mounted } from "@/lib/base-path";
import { cn } from "@/lib/utils";
import riveWasmUrl from "@rive-app/webgl2/rive.wasm?url";
import type { RiveParameters } from "@rive-app/react-webgl2";
import {
  RuntimeLoader,
  useRive,
  useStateMachineInput,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
} from "@rive-app/react-webgl2";
import type { FC, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

// ── VENDORED FROM vercel/ai-elements (Apache-2.0), WITH TWO CHANGES ─────────────────────────
//
// Upstream fetches each `.riv` from Vercel's blob CDN and lets the Rive runtime pull its WASM from
// a public CDN. Collie's CSP is `connect-src 'self'` and the app collects nothing off-host, so
// both are SAME-ORIGIN here: the six `.riv` files sit in `public/persona/` and the WASM is a
// Vite-hashed asset of this bundle. Neither is precached (sw.ts / globPatterns leave them out);
// they load the first time the voice sheet opens. Re-vendor with `npx ai-elements add persona`
// and re-apply these two edits.
RuntimeLoader.setWasmUrl(riveWasmUrl);

const asset = (name: string): string => mounted(`/persona/${name}`);

// Delays Rive initialization by one frame so that React Strict Mode's
// immediate unmount cycle never creates a WebGL2 context. Only the
// second (real) mount will initialise, avoiding context exhaustion.
const useStrictModeSafeInit = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => {
      cancelAnimationFrame(id);
      setReady(false);
    };
  }, []);

  return ready;
};

export type PersonaState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "asleep";

type LoadedRive = Parameters<NonNullable<RiveParameters["onLoad"]>>[0];
type LoadError = Parameters<NonNullable<RiveParameters["onLoadError"]>>[0];
type RiveEvent = Parameters<NonNullable<RiveParameters["onPlay"]>>[0];

interface PersonaProps {
  state: PersonaState;
  onLoad?: RiveParameters["onLoad"];
  onLoadError?: RiveParameters["onLoadError"];
  onReady?: () => void;
  onPause?: RiveParameters["onPause"];
  onPlay?: RiveParameters["onPlay"];
  onStop?: RiveParameters["onStop"];
  className?: string;
  variant?: keyof typeof sources;
}

// The state machine name is always 'default' for Elements AI visuals
const stateMachine = "default";

const sources = {
  command: {
    dynamicColor: true,
    hasModel: true,
    source:
      asset("command-2.0.riv"),
  },
  glint: {
    dynamicColor: true,
    hasModel: true,
    source:
      asset("glint-2.0.riv"),
  },
  halo: {
    dynamicColor: true,
    hasModel: true,
    source:
      asset("halo-2.0.riv"),
  },
  mana: {
    dynamicColor: false,
    hasModel: true,
    source:
      asset("mana-2.0.riv"),
  },
  obsidian: {
    dynamicColor: true,
    hasModel: true,
    source:
      asset("obsidian-2.0.riv"),
  },
  opal: {
    dynamicColor: false,
    hasModel: false,
    source:
      asset("orb-1.2.riv"),
  },
};

// A client-only SPA: there is no server render to guard against, so `window` is always there.
const getCurrentTheme = (): "light" | "dark" => {
  if (document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
};

const useTheme = (enabled: boolean) => {
  const [theme, setTheme] = useState<"light" | "dark">(getCurrentTheme);

  useEffect(() => {
    // Skip if not enabled (avoids unnecessary observers for non-dynamic-color variants)
    if (!enabled) {
      return;
    }

    // Watch for classList changes
    const observer = new MutationObserver(() => {
      setTheme(getCurrentTheme());
    });

    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });

    // Watch for OS-level theme changes
    let mql: MediaQueryList | null = null;
    const handleMediaChange = () => {
      setTheme(getCurrentTheme());
    };

    if (window.matchMedia) {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", handleMediaChange);
    }

    return () => {
      observer.disconnect();
      if (mql) {
        mql.removeEventListener("change", handleMediaChange);
      }
    };
  }, [enabled]);

  return theme;
};

interface PersonaWithModelProps {
  rive: ReturnType<typeof useRive>["rive"];
  source: (typeof sources)[keyof typeof sources];
  children: React.ReactNode;
}

const PersonaWithModel = memo(
  ({ rive, source, children }: PersonaWithModelProps) => {
    const theme = useTheme(source.dynamicColor);
    const viewModel = useViewModel(rive, { useDefault: true });
    const viewModelInstance = useViewModelInstance(viewModel, {
      rive,
      useDefault: true,
    });
    const viewModelInstanceColor = useViewModelInstanceColor(
      "color",
      viewModelInstance
    );

    useEffect(() => {
      if (!(viewModelInstanceColor && source.dynamicColor)) {
        return;
      }

      const [r, g, b] = theme === "dark" ? [255, 255, 255] : [0, 0, 0];
      viewModelInstanceColor.setRgb(r, g, b);
    }, [viewModelInstanceColor, theme, source.dynamicColor]);

    return children;
  }
);

PersonaWithModel.displayName = "PersonaWithModel";

interface PersonaWithoutModelProps {
  children: ReactNode;
}

const PersonaWithoutModel = memo(
  ({ children }: PersonaWithoutModelProps) => children
);

PersonaWithoutModel.displayName = "PersonaWithoutModel";

export const Persona: FC<PersonaProps> = memo(
  ({
    variant = "obsidian",
    state = "idle",
    onLoad,
    onLoadError,
    onReady,
    onPause,
    onPlay,
    onStop,
    className,
  }) => {
    const source = sources[variant];

    if (!source) {
      throw new Error(`Invalid variant: ${variant}`);
    }

    // Stabilize callbacks to prevent useRive from reinitializing
    const callbacksRef = useRef({
      onLoad,
      onLoadError,
      onPause,
      onPlay,
      onReady,
      onStop,
    });

    useEffect(() => {
      callbacksRef.current = {
        onLoad,
        onLoadError,
        onPause,
        onPlay,
        onReady,
        onStop,
      };
    }, [onLoad, onLoadError, onPause, onPlay, onReady, onStop]);

    const stableCallbacks = useMemo(
      () => ({
        onLoad: (loadedRive: LoadedRive) => callbacksRef.current.onLoad?.(loadedRive),
        onLoadError: (err: LoadError) => callbacksRef.current.onLoadError?.(err),
        onPause: (event: RiveEvent) => callbacksRef.current.onPause?.(event),
        onPlay: (event: RiveEvent) => callbacksRef.current.onPlay?.(event),
        onReady: () => callbacksRef.current.onReady?.(),
        onStop: (event: RiveEvent) => callbacksRef.current.onStop?.(event),
      }),
      []
    );

    // Delay initialisation by one frame to avoid creating (and leaking)
    // a WebGL2 context during React Strict Mode's first throw-away mount.
    const ready = useStrictModeSafeInit();

    const { rive, RiveComponent } = useRive(
      ready
        ? {
            autoplay: true,
            onLoad: stableCallbacks.onLoad,
            onLoadError: stableCallbacks.onLoadError,
            onPause: stableCallbacks.onPause,
            onPlay: stableCallbacks.onPlay,
            onRiveReady: stableCallbacks.onReady,
            onStop: stableCallbacks.onStop,
            src: source.source,
            stateMachines: stateMachine,
          }
        : null
    );

    const listeningInput = useStateMachineInput(
      rive,
      stateMachine,
      "listening"
    );
    const thinkingInput = useStateMachineInput(rive, stateMachine, "thinking");
    const speakingInput = useStateMachineInput(rive, stateMachine, "speaking");
    const asleepInput = useStateMachineInput(rive, stateMachine, "asleep");

    // Rive state machine inputs are mutable objects that must be set via direct
    // property assignment — this is the intended Rive API, not a React anti-pattern.
    useEffect(() => {
      if (listeningInput) {
        listeningInput.value = state === "listening";
      }
      if (thinkingInput) {
        thinkingInput.value = state === "thinking";
      }
      if (speakingInput) {
        speakingInput.value = state === "speaking";
      }
      if (asleepInput) {
        asleepInput.value = state === "asleep";
      }
    }, [state, listeningInput, thinkingInput, speakingInput, asleepInput]);

    const Component = source.hasModel ? PersonaWithModel : PersonaWithoutModel;

    return (
      <Component rive={rive} source={source}>
        <RiveComponent className={cn("size-16 shrink-0", className)} />
      </Component>
    );
  }
);

Persona.displayName = "Persona";
