import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './app.css';
import { loadDesignSystem } from './ds.js';

// the design system must be on the page before any screen renders
loadDesignSystem().then(() => {
  const root = document.getElementById('root');
  if (!root) throw new Error('no #root');
  createRoot(root).render(<App storage={localStorage} />);
});
