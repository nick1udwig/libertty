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
