import assert from 'node:assert/strict';

export async function assertPaneStack(group) {
  const panes = await group.locator('.herdr-pane').evaluateAll(elements => elements.map(element => {
    const { left, top, bottom } = element.getBoundingClientRect();
    return { left, top, bottom };
  }));
  assert.ok(panes.length > 1, 'The fixture has several panes');
  const split = await group.locator('.herdr-pane-add').boundingBox();
  assert.ok(split && split.y >= panes.at(-1).bottom, 'Split has its own row below every pane');
  assert.equal(split.x, panes[0].left, 'Split aligns with the pane rows');
  for (let i = 1; i < panes.length; i++) {
    assert.ok(panes[i].top >= panes[i - 1].bottom, 'Each pane occupies a separate row');
    assert.equal(panes[i].left, panes[0].left, 'Pane rows align vertically');
  }
}

export async function assertPaneTitleRoom(group, wrapped = false) {
  const bounds = await group.boundingBox();
  const panes = await group.locator('.herdr-pane').evaluateAll(elements => elements.map(pane => {
    const name = pane.querySelector('.herdr-pane-name'), close = pane.querySelector('.herdr-pane-close');
    return { right: pane.getBoundingClientRect().right, width: name.clientWidth, height: name.clientHeight,
      line: parseFloat(getComputedStyle(name).lineHeight), closeWidth: close.getBoundingClientRect().width };
  }));
  for (const pane of panes) {
    assert.ok(pane.right <= bounds.x + bounds.width + 1, 'Pane rows fit the mobile tree');
    assert.ok(pane.width > 140, 'Titles use more than the old 140-pixel limit');
    assert.ok(pane.closeWidth >= 32, 'Long names do not shrink close buttons');
    assert.ok(pane.height <= pane.line * 2 + 1, 'Titles use at most two lines');
  }
  if (wrapped) assert.ok(panes.some(pane => pane.height > pane.line + 1), 'Long titles wrap onto a second line');
}
