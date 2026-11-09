import { Vault, EventRef, TAbstractFile } from 'obsidian';

export type ReloadCallback = () => void;

export class VaultWatcher {
  private vault: Vault | null;
  private getCurrentFilePath?: () => string | null;
  private onReload?: ReloadCallback;
  private trackedDependencies: Set<string> = new Set();
  private eventRef: EventRef | null = null;
  private lifecycleRefs: EventRef[] = [];

  // Global & Multi-view dependency maps
  private viewsByHtmlPath: Map<string, Set<ReloadCallback>> = new Map();
  private dependenciesByHtmlPath: Map<string, Map<ReloadCallback | null, Set<string>>> = new Map();

  constructor(vault: Vault | null | undefined, getCurrentFilePath?: () => string | null, onReload?: ReloadCallback) {
    this.vault = vault || null;
    this.getCurrentFilePath = getCurrentFilePath;
    this.onReload = onReload;
  }

  public normalizePath(path: string | null | undefined): string {
    if (!path) return '';
    let normalized = path.replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
      normalized = normalized.substring(2);
    }
    const parts = normalized.split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      }
      if (part === '..') {
        if (stack.length > 0) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }
    return stack.join('/');
  }

  public setDependencies(dependencies: string[]): void {
    this.trackedDependencies = new Set(dependencies.map(d => this.normalizePath(d)));
    if (this.getCurrentFilePath) {
      const currentPath = this.getCurrentFilePath();
      if (currentPath) {
        this.updateDependencies(currentPath, dependencies);
      }
    }
  }

  public registerView(htmlPath: string, callback: ReloadCallback, dependencies: string[] = []): void {
    if (!htmlPath) return;
    const normHtmlPath = this.normalizePath(htmlPath);
    if (!this.viewsByHtmlPath.has(normHtmlPath)) {
      this.viewsByHtmlPath.set(normHtmlPath, new Set());
    }
    this.viewsByHtmlPath.get(normHtmlPath)!.add(callback);
    this.updateDependencies(normHtmlPath, dependencies, callback);
  }

  public updateDependencies(htmlPath: string, dependencies: string[], callback?: ReloadCallback): void {
    if (!htmlPath) return;
    const normHtmlPath = this.normalizePath(htmlPath);
    const normDeps = new Set(dependencies.map(d => this.normalizePath(d)));

    if (!this.dependenciesByHtmlPath.has(normHtmlPath)) {
      this.dependenciesByHtmlPath.set(normHtmlPath, new Map());
    }
    const viewMap = this.dependenciesByHtmlPath.get(normHtmlPath)!;

    let targetCb: ReloadCallback | null = callback || null;
    if (!targetCb && this.onReload && this.getCurrentFilePath) {
      const current = this.getCurrentFilePath();
      if (current && this.normalizePath(current) === normHtmlPath) {
        targetCb = this.onReload;
      }
    }

    if (targetCb) {
      viewMap.set(targetCb, normDeps);
    } else {
      const existingCbs = this.viewsByHtmlPath.get(normHtmlPath);
      if (existingCbs && existingCbs.size > 0) {
        existingCbs.forEach(cb => viewMap.set(cb, normDeps));
      } else {
        viewMap.set(null, normDeps);
      }
    }
  }

  public unregisterView(htmlPath: string, callback?: ReloadCallback): void {
    if (!htmlPath) return;
    const normHtmlPath = this.normalizePath(htmlPath);
    const callbacks = this.viewsByHtmlPath.get(normHtmlPath);
    const viewMap = this.dependenciesByHtmlPath.get(normHtmlPath);

    if (callback) {
      if (callbacks) {
        callbacks.delete(callback);
      }
      if (viewMap) {
        viewMap.delete(callback);
      }
    } else {
      if (viewMap) {
        viewMap.delete(null);
        if (this.onReload) {
          viewMap.delete(this.onReload);
        }
      }
      if (callbacks && this.onReload) {
        callbacks.delete(this.onReload);
      }
    }

    if (callbacks && callbacks.size === 0) {
      this.viewsByHtmlPath.delete(normHtmlPath);
      this.dependenciesByHtmlPath.delete(normHtmlPath);
    } else if (viewMap && viewMap.size === 0 && (!callbacks || callbacks.size === 0)) {
      this.dependenciesByHtmlPath.delete(normHtmlPath);
    }
  }

  /** Remove a subscriber independently of mutable TFile paths (including folder renames). */
  public unregisterCallback(callback: ReloadCallback): void {
    for (const path of [...this.viewsByHtmlPath.keys()]) this.unregisterView(path, callback);
  }

  public getDependencies(htmlPath: string): string[] {
    const normHtmlPath = this.normalizePath(htmlPath);
    const viewMap = this.dependenciesByHtmlPath.get(normHtmlPath);
    if (viewMap) {
      const combined = new Set<string>();
      for (const assetSet of viewMap.values()) {
        assetSet.forEach(asset => combined.add(asset));
      }
      if (combined.size > 0) {
        return Array.from(combined);
      }
    }
    return Array.from(this.trackedDependencies);
  }

  public register(): void {
    const vault = this.vault;
    if (this.eventRef || !vault || typeof vault.on !== 'function') return;

    const notify = (file: TAbstractFile) => {
      if (!file || !file.path) return;
      const modifiedPath = this.normalizePath(file.path);
      const triggeredCallbacks = new Set<ReloadCallback>();

      // 1. Single instance legacy check
      if (this.getCurrentFilePath && this.onReload) {
        const rawCurrent = this.getCurrentFilePath();
        if (rawCurrent) {
          const currentPath = this.normalizePath(rawCurrent);
          if (modifiedPath === currentPath || currentPath.startsWith(modifiedPath + '/') || [...this.trackedDependencies].some(path => path === modifiedPath || path.startsWith(modifiedPath + '/'))) {
            triggeredCallbacks.add(this.onReload);
          }
        }
      }

      // 2. Multi-view direct HTML match check
      for (const [path, subscribers] of this.viewsByHtmlPath) {
        if (path === modifiedPath || path.startsWith(modifiedPath + '/')) subscribers.forEach(cb => triggeredCallbacks.add(cb));
      }

      // 3. Asset dependency match check
      for (const [htmlPath, viewMap] of this.dependenciesByHtmlPath.entries()) {
        const activeSubscribers = this.viewsByHtmlPath.get(htmlPath);
        for (const [cb, assets] of viewMap.entries()) {
          if ([...assets].some(path => path === modifiedPath || path.startsWith(modifiedPath + '/'))) {
            if (cb) {
              if (cb === this.onReload || (activeSubscribers && activeSubscribers.has(cb))) {
                triggeredCallbacks.add(cb);
              }
            } else if (activeSubscribers) {
              activeSubscribers.forEach(c => triggeredCallbacks.add(c));
            }
          }
        }
      }

      // Execute all unique triggered callbacks safely
      triggeredCallbacks.forEach(cb => {
        try {
          cb();
        } catch (err) {
          console.error('Error executing reload callback in VaultWatcher:', err);
        }
      });
    };
    this.eventRef = vault.on('modify', notify);
    this.lifecycleRefs = [vault.on('create', notify), vault.on('delete', notify), vault.on('rename', (file, oldPath) => {
      const before = this.normalizePath(oldPath);
      const after = this.normalizePath(file.path);
      const affected = new Set<ReloadCallback>();
      for (const [htmlPath, callbacks] of [...this.viewsByHtmlPath]) {
        const moved = htmlPath === before || htmlPath.startsWith(before + '/');
        const dependencies = this.dependenciesByHtmlPath.get(htmlPath);
        if (moved) {
          const destination = after + htmlPath.slice(before.length);
          this.viewsByHtmlPath.delete(htmlPath);
          this.dependenciesByHtmlPath.delete(htmlPath);
          const existing = this.viewsByHtmlPath.get(destination) || new Set<ReloadCallback>();
          callbacks.forEach(cb => { existing.add(cb); affected.add(cb); });
          this.viewsByHtmlPath.set(destination, existing);
          const merged = this.dependenciesByHtmlPath.get(destination) || new Map<ReloadCallback | null, Set<string>>();
          dependencies?.forEach((deps, cb) => merged.set(cb, deps));
          this.dependenciesByHtmlPath.set(destination, merged);
        }
        dependencies?.forEach((deps, cb) => {
          if ([...deps].some(path => path === before || path.startsWith(before + '/') || path === after || path.startsWith(after + '/'))) {
            if (cb) affected.add(cb);
            else callbacks.forEach(callback => affected.add(callback));
          }
        });
      }
      affected.forEach(callback => {
        try { callback(); } catch (error) { console.error('Error reloading renamed HTML:', error); }
      });
    })];
  }

  public unregister(): void {
    const vault = this.vault;
    if (this.eventRef && vault && typeof vault.offref === 'function') {
      vault.offref(this.eventRef);
      this.eventRef = null;
    }
    if (vault && typeof vault.offref === 'function') this.lifecycleRefs.forEach(ref => vault.offref(ref));
    this.lifecycleRefs = [];
    this.viewsByHtmlPath.clear();
    this.dependenciesByHtmlPath.clear();
    this.trackedDependencies.clear();
  }
}
