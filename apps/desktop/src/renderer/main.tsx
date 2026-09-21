import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClassroomPresentation } from './presentation/ClassroomPresentation';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少根节点');
}
const params = new URLSearchParams(window.location.search);
const presentationSession = params.get('presentationSession');

createRoot(container).render(
  <React.StrictMode>
    {presentationSession ? <ClassroomPresentation sessionId={presentationSession} /> : <App />}
  </React.StrictMode>
);
