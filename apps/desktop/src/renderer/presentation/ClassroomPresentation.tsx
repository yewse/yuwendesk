import React, { useEffect, useState } from 'react';
import type { PresentationDTO } from '../../main/presentation/service';

void React;

export function ClassroomPresentation({ sessionId }: { sessionId: string }): JSX.Element {
  const [presentation, setPresentation] = useState<PresentationDTO | null>(null);
  const [index, setIndex] = useState(0);
  const [hintShown, setHintShown] = useState(false);
  const [answerShown, setAnswerShown] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    void window.yuwen.presentationGet(sessionId).then((response) => {
      if (!mounted) return;
      if (response.ok) setPresentation(response.data);
      else setError(`${response.error.message_zh} ${response.error.next_action}`);
    });
    return () => { mounted = false; };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void window.yuwen.presentationClose();
      if (!presentation) return;
      if (event.key === 'ArrowRight') {
        setIndex((value) => Math.min(value + 1, presentation.slides.length - 1));
        setHintShown(false);
        setAnswerShown(false);
      }
      if (event.key === 'ArrowLeft') {
        setIndex((value) => Math.max(value - 1, 0));
        setHintShown(false);
        setAnswerShown(false);
      }
      if (event.key.toLowerCase() === 'h') setHintShown(true);
      if (event.key.toLowerCase() === 'a') setAnswerShown(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentation]);

  if (error) return <main className="presentation-shell"><div className="notice warn" role="alert">{error}</div></main>;
  if (!presentation) return <main className="presentation-shell"><p>正在读取当前已审查方案…</p></main>;
  const slide = presentation.slides[index];
  return (
    <main className="presentation-shell">
      <header className="presentation-header"><div><b>{presentation.title}</b><span>{presentation.classDisplayName} · {presentation.lessonTitle}</span></div><button className="btn" onClick={() => void window.yuwen.presentationClose()}>关闭展示</button></header>
      <article className="presentation-slide" aria-live="polite">
        <div className="presentation-count">{index + 1} / {presentation.slides.length}</div>
        <h1>{slide.title}</h1>
        <p className="presentation-prompt">{slide.prompt}</p>
        {hintShown && <section className="presentation-reveal hint"><h2>提示</h2><p>{slide.hint || '本任务没有额外提示。'}</p></section>}
        {answerShown && <section className="presentation-reveal answer"><h2>合理答案范围</h2><ul>{slide.answerScope.map((answer) => <li key={answer}>{answer}</li>)}</ul></section>}
      </article>
      <footer className="presentation-controls">
        <button className="btn" disabled={index === 0} onClick={() => { setIndex((value) => value - 1); setHintShown(false); setAnswerShown(false); }}>上一题</button>
        <button className="btn" onClick={() => setHintShown(true)} disabled={hintShown}>显示提示</button>
        <button className="btn" onClick={() => setAnswerShown(true)} disabled={answerShown}>显示答案</button>
        <button className="btn primary" disabled={index === presentation.slides.length - 1} onClick={() => { setIndex((value) => value + 1); setHintShown(false); setAnswerShown(false); }}>下一题</button>
      </footer>
      <p className="presentation-shortcuts">方向键切换 · H 显示提示 · A 显示答案 · Esc 关闭</p>
    </main>
  );
}
