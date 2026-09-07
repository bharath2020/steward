// Run only in the disposable setup-test checkout, after setup has submitted its example.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const Ajv = require('ajv');
const { Client, Connection } = require('@temporalio/client');
const { sha256Json } = require('../src/completion-receipt');

async function main() {
  assert.equal(process.env.STEWARD_ISOLATED_SETUP_TEST, '1', 'This harness belongs in a disposable checkout');
  const intent = JSON.parse(fs.readFileSync('runtime/services/setup-start.json'));
  const connection = await Connection.connect({ address: '127.0.0.1:7233' });
  try {
    const client = new Client({ connection });
    const handle = client.workflow.getHandle(intent.workflowId);
    const deadline = Date.now() + 60_000;
    let description;
    do {
      description = await handle.describe();
      if (description.status.name !== 'RUNNING') break;
      assert(Date.now() < deadline, 'Example did not finish within 60 seconds');
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (true);
    assert.equal(description.status.name, 'COMPLETED');
    const base = `runtime/runs/${intent.runId}`;
    const read = path => JSON.parse(fs.readFileSync(`${base}/${path}`));
    const state = read('state.json');
    assert.equal(state.status, 'completed');
    assert.equal(state.temporalRunId, description.runId);
    const output = read('nodes/review/output.json');
    const dispatch = fs.readdirSync(`${base}/nodes/review/dispatches`).sort()[0];
    const dispatchRoot = `nodes/review/dispatches/${dispatch}`;
    const schema = read(`${dispatchRoot}/schema.json`);
    const receipt = read(`${dispatchRoot}/completion-receipt.json`);
    const { receiptSha256, ...body } = receipt;
    assert(new Ajv().validate(schema, output));
    assert.deepEqual(receipt, read(`receipts/review-iteration-01-recovery-0000-${receipt.receiptToken}.json`));
    assert.deepEqual(receipt.output, output);
    assert.equal(receipt.runId, intent.runId);
    assert.equal(receipt.temporalRunId, description.runId);
    assert.equal(receipt.outputSha256, sha256Json(output));
    assert.equal(receiptSha256, sha256Json(body));
    assert.deepEqual(await handle.result(), { review: output });
    const before = fs.readdirSync('runtime/runs').sort();
    assert.equal(before.length, 1, 'Fresh setup should submit exactly one run');
    execFileSync('/bin/bash', ['scripts/setup.sh', '--no-open'], { stdio: 'inherit' });
    assert.deepEqual(fs.readdirSync('runtime/runs').sort(), before, 'Second setup created a duplicate');
    assert.deepEqual(read('nodes/review/output.json'), output);
    const response = await fetch('http://127.0.0.1:4310/');
    assert.equal(response.status, 200);
    assert((await response.text()).includes('Steward'));
    fs.mkdirSync('output', { recursive: true });
    const verdict = { passed: true, commit: process.env.GITHUB_SHA, platform: process.platform,
      node: process.version, runId: intent.runId, temporalRunId: description.runId,
      temporalStatus: description.status.name, outputSha256: receipt.outputSha256,
      schemaValid: true, receiptHashesValid: true, repeatSetupNoDuplicate: true, dashboardHttp: 200 };
    fs.writeFileSync('output/isolated-setup-verdict.json', JSON.stringify(verdict, null, 2));
    console.log(JSON.stringify(verdict, null, 2));
  } finally { await connection.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
