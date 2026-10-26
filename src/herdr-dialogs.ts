import { node } from './dom.ts';
import { herdrName, type HerdrAgent, type HerdrSpace, type HerdrWorktrees } from './herdr-protocol.ts';
import { worktreePath, type SpaceRepo } from './herdr-spaces.ts';

export type StripItem = HerdrAgent & { space?: HerdrSpace; repo?: SpaceRepo };
/** The space or terminal a Herdr action created, which the strip selects after refreshing. */
export interface Created { workspaceId?: string; terminalId?: string }
export interface DialogHost {
  api<T>(path: string, data?: unknown): Promise<T>;
  refresh(created?: Created): Promise<void>;
  closeMenu(): void;
  closeTab(item: StripItem): Promise<void>;
  closing: Set<string>;
  terminalName(id: string): string | undefined;
}

/** A modal form with Cancel, status and error lines; Cancel and Escape wait while it is busy. */
function formDialog(className: string, heading: string) {
  const modal = node('dialog', className), form = node('form'), title = node('h2', '', heading);
  const progress = node('p'), error = node('p', 'form-error'), actions = node('div', 'actions'), cancel = node('button', 'secondary', 'Cancel');
  progress.role = 'status'; error.role = 'alert'; cancel.type = 'button';
  const dialog = { modal, form, title, progress, error, actions, cancel, busy: false };
  cancel.onclick = () => modal.close(); modal.oncancel = event => { if (dialog.busy) event.preventDefault(); };
  modal.append(form);
  return dialog;
}
function submitButton(className: string, label: string) {
  const button = node('button', className, label); button.type = 'submit'; return button;
}
function show(modal: HTMLDialogElement, focus: HTMLElement) { document.body.append(modal); modal.showModal(); focus.focus(); }

/** Space and agent dialogs, at most one action dialog at a time. */
export class HerdrDialogs {
  active?: HTMLDialogElement;
  private host: DialogHost;
  constructor(host: DialogHost) { this.host = host; }
  private claim(modal: HTMLDialogElement) {
    this.active = modal;
    modal.onclose = () => { if (this.active === modal) this.active = undefined; modal.remove(); };
  }
  closeSpace(item: StripItem) {
    const space = item.space;
    if (!space || this.active || this.host.closing.has(item.terminalId)) return;
    this.host.closeMenu();
    const { modal, form, title, actions, cancel } = formDialog('herdr-space-action herdr-close-space', 'Close ' + space.name + '?');
    this.claim(modal);
    title.id = 'close-space-' + crypto.randomUUID(); modal.setAttribute('aria-labelledby', title.id);
    const count = space.terminalIds.length;
    const explanation = node('p', '', 'This ends ' + (count === 1 ? 'its terminal' : 'its ' + count + ' terminals') + ' on the Herdr server.');
    const checkout = node('p', 'hint', 'The checkout stays on disk. Delete it to remove the folder too; the branch is kept.');
    const linked = !!space.linkedWorktree && !!space.checkoutPath; checkout.hidden = !linked;
    const close = submitButton('danger', 'Close space'), remove = node('button', 'danger', 'Delete checkout…');
    remove.type = 'button'; remove.hidden = !linked;
    // Dialogs report closing asynchronously, so release this one before the deletion dialog opens.
    remove.onclick = () => { this.active = undefined; modal.close(); this.deleteWorktree(item); };
    form.onsubmit = event => { event.preventDefault(); modal.close(); void this.host.closeTab(item); };
    actions.append(cancel, close, remove); form.append(title, explanation, checkout, actions); show(modal, cancel);
  }
  deleteWorktree(item: StripItem) {
    const space = item.space;
    if (!space?.linkedWorktree || !space.checkoutPath || this.active || this.host.closing.has(item.terminalId)) return;
    this.host.closeMenu();
    const dialog = formDialog('herdr-space-action herdr-delete-worktree', 'Delete worktree checkout?'), { modal, form, title, progress, error, actions, cancel } = dialog;
    this.claim(modal);
    title.id = 'delete-worktree-title'; modal.setAttribute('aria-labelledby', title.id);
    const explanation = node('p', '', 'This removes the checkout folder:');
    const path = node('p', 'herdr-checkout-path', space.checkoutPath);
    const hint = node('p', '', 'The branch is not deleted. The Herdr workspace will close.');
    const forceHint = node('p', '', 'Force delete permanently discards modified and untracked files in this checkout.'); forceHint.hidden = true;
    const remove = submitButton('danger', 'Delete worktree checkout'), forceRemove = submitButton('danger', 'Force delete'); forceRemove.hidden = true;
    form.onsubmit = async event => {
      event.preventDefault(); if (dialog.busy) return;
      const force = event.submitter === forceRemove;
      if (force && forceRemove.hidden) return;
      dialog.busy = true; this.host.closing.add(item.terminalId); remove.disabled = forceRemove.disabled = cancel.disabled = true; error.textContent = ''; progress.textContent = 'Deleting worktree checkout…';
      try {
        await this.host.api('api/herdr/action', { action: 'delete-worktree', workspaceId: space.id, path: space.checkoutPath, force });
        await this.host.refresh();
        modal.close();
      } catch (reason: any) {
        if (modal.open) { error.textContent = reason.message; forceRemove.hidden = forceHint.hidden = !/--force\b/.test(reason.message); }
      }
      finally { dialog.busy = false; this.host.closing.delete(item.terminalId); remove.disabled = forceRemove.disabled = cancel.disabled = false; progress.textContent = ''; }
    };
    actions.append(cancel, remove, forceRemove); form.append(title, explanation, path, hint, forceHint, progress, error, actions); show(modal, cancel);
  }
  async spaceAction(item: StripItem, action: 'new-worktree' | 'open-worktree' | 'split', terminalId: string) {
    if (!item.space || this.active) return;
    const space = item.space;
    this.host.closeMenu();
    const dialog = formDialog('herdr-space-action', action === 'split' ? 'Split terminal' : action === 'new-worktree' ? 'New worktree' : 'Open worktree');
    const { modal, form, title, progress, error, actions, cancel } = dialog;
    this.claim(modal);
    const context = node('p', '', space.name), fields = node('div');
    const submit = submitButton('primary', action === 'split' ? 'Split' : action === 'new-worktree' ? 'Create' : 'Open'); submit.disabled = true;
    actions.append(cancel, submit); form.append(title, context, fields, progress, error, actions); document.body.append(modal); modal.showModal();
    const field = (label: string, input: HTMLElement) => { const wrapper = node('label', '', label); wrapper.append(input); fields.append(wrapper); };
    const input = node('input'), picker = node('select');
    const branch = action === 'new-worktree' ? branchField(input, fields, submit, dialog, field) : undefined;
    if (action === 'split') {
      field('Split direction', picker); picker.setAttribute('aria-label', 'Split direction');
      for (const [value, label] of [['right', 'Right (side by side)'], ['down', 'Down (above and below)']]) { const option = node('option', '', label); option.value = value; picker.append(option); }
      context.textContent = space.name + ' · ' + (this.host.terminalName(terminalId) || 'No running terminal');
      submit.disabled = !terminalId;
    }
    form.onsubmit = async event => {
      event.preventDefault(); if (dialog.busy || submit.disabled) return;
      dialog.busy = true; submit.disabled = cancel.disabled = true; input.disabled = picker.disabled = true; error.textContent = ''; progress.textContent = action === 'split' ? 'Splitting…' : action === 'new-worktree' ? 'Creating worktree…' : 'Opening worktree…';
      branch?.update();
      try {
        const created = await this.host.api<Created>('api/herdr/action', { action, workspaceId: space.id, ...(action === 'split' ? { terminalId, direction: picker.value } : action === 'new-worktree' ? { branch: herdrName(input.value) } : { path: picker.value }) });
        await this.host.refresh(created); modal.close();
      } catch (reason: any) { if (modal.open) error.textContent = reason.message; }
      finally { dialog.busy = false; submit.disabled = cancel.disabled = input.disabled = picker.disabled = false; progress.textContent = ''; branch?.update(); }
    };
    if (action === 'split') return;
    progress.textContent = 'Loading worktrees…';
    try {
      const listing = await this.host.api<HerdrWorktrees>('api/herdr/action', { action: 'list-worktrees', workspaceId: space.id });
      if (!modal.open) return;
      if (!dialog.busy) progress.textContent = '';
      context.textContent = space.name + ' · ' + listing.source.repo_root;
      if (branch) branch.load(listing);
      else {
        picker.required = true; picker.setAttribute('aria-label', 'Worktree'); field('Worktree', picker);
        for (const entry of listing.worktrees.filter(entry => !entry.is_bare && !entry.is_prunable)) {
          const option = node('option', '', (entry.branch || entry.label) + ' · ' + entry.path + (entry.open_workspace_id ? ' (already open)' : '')); option.value = entry.path; picker.append(option);
        }
        submit.disabled = !picker.options.length;
        if (submit.disabled) error.textContent = 'No Git worktrees found for this repo.';
      }
    } catch (reason: any) { if (modal.open && !dialog.busy) { progress.textContent = ''; error.textContent = reason.message; } }
  }
  rename(agent: StripItem) {
    this.host.closeMenu();
    const { modal, form, title, error, actions, cancel } = formDialog('herdr-rename', agent.space ? 'Rename space' : 'Rename agent tab');
    modal.onclose = () => modal.remove();
    const input = node('input'), save = submitButton('primary', 'Save');
    input.value = agent.name; input.maxLength = 100; input.required = true; input.setAttribute('aria-label', agent.space ? 'Space name' : 'Agent tab name');
    const hint = node('p', 'hint', 'This changes the name in the desktop Herdr session too.');
    actions.append(cancel, save); form.append(title, input, hint, error, actions);
    form.onsubmit = async event => {
      event.preventDefault(); save.disabled = true;
      try { await this.host.api('api/herdr/action', { action: agent.space ? 'rename-space' : 'rename', terminalId: agent.terminalId, workspaceId: agent.space?.id, name: herdrName(input.value) }); await this.host.refresh(); modal.close(); }
      catch (reason: any) { error.textContent = reason.message; } finally { save.disabled = false; }
    };
    show(modal, input); input.select();
  }
}

/** A branch combobox that suggests existing branches and previews the new checkout path. */
function branchField(input: HTMLInputElement, fields: HTMLElement, submit: HTMLButtonElement, dialog: { busy: boolean }, field: (label: string, input: HTMLElement) => void) {
  input.required = true; input.maxLength = 100; input.placeholder = 'New or existing branch'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', 'Branch'); field('Branch', input);
  const suggestions = node('div', 'herdr-branch-suggestions'); suggestions.id = 'herdr-branches-' + crypto.randomUUID(); suggestions.role = 'listbox'; suggestions.setAttribute('aria-label', 'Existing branches');
  input.role = 'combobox'; input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', suggestions.id);
  fields.append(suggestions);
  const preview = node('p', 'hint'); fields.append(preview);
  let listing: HerdrWorktrees | undefined, branches: string[] = [], checkedOut = new Set<string>();
  let expanded = true, activeBranch = '';
  const choose = (branch: string) => { if (dialog.busy) return; input.value = branch; input.focus(); expanded = false; activeBranch = ''; update(); };
  const update = () => {
    const value = input.value.trim(), query = value.toLowerCase();
    const matches = branches.filter(branch => branch.toLowerCase().includes(query)).sort((a, b) => Number(b.toLowerCase().startsWith(query)) - Number(a.toLowerCase().startsWith(query)) || a.localeCompare(b)).slice(0, 20);
    suggestions.replaceChildren(); input.removeAttribute('aria-activedescendant');
    for (const branch of matches) {
      const option = node('button', 'herdr-branch-option', branch); option.type = 'button'; option.role = 'option'; option.tabIndex = -1; option.id = suggestions.id + '-' + suggestions.childElementCount;
      option.disabled = dialog.busy || checkedOut.has(branch); option.setAttribute('aria-selected', String(branch === activeBranch));
      if (checkedOut.has(branch)) option.append(node('span', 'herdr-branch-status', 'Already checked out'));
      if (branch === activeBranch) input.setAttribute('aria-activedescendant', option.id);
      option.onpointerdown = event => event.preventDefault(); option.onclick = () => choose(branch); suggestions.append(option);
    }
    suggestions.hidden = !expanded || !matches.length; input.setAttribute('aria-expanded', String(!suggestions.hidden));
    submit.disabled = dialog.busy || !value || checkedOut.has(value);
    preview.textContent = checkedOut.has(value) ? 'This branch is already checked out. Use Open worktree to open its checkout.' : !value ? 'Choose an existing branch or enter a new branch name.' : listing?.directory ? 'Checkout: ' + worktreePath(listing.directory, listing.source.repo_name, value) : branches.includes(value) ? 'Herdr will create the checkout using this existing branch.' : 'Herdr will create the checkout in its configured worktree directory from HEAD.';
  };
  const available = () => [...suggestions.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  input.oninput = () => { expanded = true; activeBranch = ''; update(); };
  input.onfocus = () => { expanded = true; update(); };
  input.onkeydown = event => {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); expanded = false; update(); return; }
    if (event.key === 'Enter' && expanded && activeBranch) { event.preventDefault(); choose(activeBranch); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); expanded = true; update();
    const options = available();
    if (!options.length) return;
    const current = options.findIndex(option => option.textContent === activeBranch);
    activeBranch = options[(current + (event.key === 'ArrowDown' ? 1 : current < 0 ? 0 : -1) + options.length) % options.length].textContent!;
    update(); document.getElementById(input.getAttribute('aria-activedescendant')!)?.scrollIntoView({ block: 'nearest' });
  };
  update(); input.focus();
  return {
    update,
    load(value: HerdrWorktrees) {
      listing = value;
      branches = [...new Set(value.branches || [])];
      checkedOut = new Set(value.worktrees.flatMap(entry => entry.branch ? [entry.branch] : []));
      update();
    },
  };
}
