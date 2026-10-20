'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { cn } from '@/lib/cn';

const MAX_SECONDS = 60;
// What this browser can record: Chrome and Firefox make webm or ogg, Safari makes mp4. The listener takes all of them.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
const pickType = () => (typeof MediaRecorder === 'undefined' ? null : TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null);

type State = 'idle' | 'recording' | 'listening';

/**
 * The microphone beside the message box. Press, speak (Tamil, English or both), press again. The words land in the box for the
 * person to read and correct; nothing is sent until they press Send. At most a minute. The recording goes to the server for the
 * listening and is not kept. Without a microphone, or when voice is not set up, the button is not there.
 */
export function VoiceButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [supported, setSupported] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setSupported(!!navigator.mediaDevices?.getUserMedia && pickType() !== null); }, []);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); stream.current?.getTracks().forEach((t) => t.stop()); }, []);

  const release = () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const stop = () => { if (recorder.current?.state === 'recording') recorder.current.stop(); };

  const start = async () => {
    setError(null);
    const type = pickType();
    if (!type) { setError("This phone can't record. Please type it."); return; }
    let s: MediaStream;
    try { s = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { setError('The microphone is not allowed. Allow it in the browser, or type it.'); return; }
    stream.current = s; chunks.current = [];
    const r = new MediaRecorder(s, { mimeType: type });
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      release();
      const blob = new Blob(chunks.current, { type });
      if (!blob.size) { setState('idle'); return; }
      setState('listening');
      try {
        const body = new FormData();
        body.append('audio', blob, 'speech');
        const res = await fetch('/api/speech/transcribe', { method: 'POST', body, credentials: 'same-origin' });
        const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
        if (res.ok && data?.text) onText(data.text); else setError(data?.error ?? "Couldn't listen just now. Please try again, or type it.");
      } catch { setError("Couldn't listen just now. Please try again, or type it."); }
      setState('idle');
    };
    recorder.current = r;
    r.start();
    setSeconds(0); setState('recording');
    timer.current = setInterval(() => setSeconds((n) => { if (n + 1 >= MAX_SECONDS) stop(); return n + 1; }), 1000);
  };

  if (!supported) return null;
  const label = state === 'recording' ? 'Stop recording' : state === 'listening' ? 'Listening to what you said' : 'Speak your message';
  return (
    <div className="relative shrink-0">
      <button type="button" aria-label={label} title={label} aria-pressed={state === 'recording'} disabled={disabled || state === 'listening'}
        onClick={() => (state === 'recording' ? stop() : void start())}
        className={cn('inline-flex size-12 items-center justify-center rounded-md border disabled:cursor-not-allowed disabled:opacity-50',
          state === 'recording' ? 'border-alert bg-alert text-white' : 'border-line bg-surface text-ink hover:bg-copper-wash')}>
        {state === 'listening' ? <Loader2 aria-hidden className="size-5 animate-spin" /> : state === 'recording' ? <Square aria-hidden className="size-5 fill-current" /> : <Mic aria-hidden className="size-5" />}
      </button>
      <span aria-live="polite" className="sr-only">{state === 'recording' ? 'Recording' : state === 'listening' ? 'Listening' : ''}</span>
      {state === 'recording' && <span aria-hidden className="num absolute -top-5 right-0 text-sm text-alert">{seconds}s</span>}
      {error && <p role="alert" className="absolute bottom-14 right-0 z-10 w-64 rounded-md border border-line bg-surface p-2 text-sm text-alert shadow">{error}</p>}
    </div>
  );
}
