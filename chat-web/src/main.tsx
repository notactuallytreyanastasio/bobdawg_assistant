// The entry: the page's origin, one root element, the app inside it. This is the only
// file that reads index.html's #root, and the only one that runs without a test behind it.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { apiOrigin } from './env';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('index.html has no #root element to render into');
}

createRoot(root).render(
  <StrictMode>
    <App origin={apiOrigin()} />
  </StrictMode>,
);
