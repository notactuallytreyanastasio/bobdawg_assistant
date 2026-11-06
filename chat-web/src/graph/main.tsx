// The graph page's entry, as main.tsx is the chat's: one root element, the app inside it.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GraphApp } from './GraphApp';
import './graph.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('graph.html has no #root element to render into');
}

createRoot(root).render(
  <StrictMode>
    <GraphApp />
  </StrictMode>,
);
