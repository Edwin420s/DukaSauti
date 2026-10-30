import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } from '@qvac/sdk';

// First run downloads/caches the model; rerun with the network disabled to prove offline inference.
let modelId;
try {
  modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, onProgress: p => console.error(`Model load ${p.percentage.toFixed(0)}%`) });
  const result = completion({ modelId, history: [{ role: 'user', content: 'Reply with exactly: DUKASAUTI_QVAC_OK' }], stream: true });
  let output = '';
  for await (const token of result.tokenStream) output += typeof token === 'string' ? token : (token?.text ?? '');
  console.log(output.trim());
  if (!output.includes('DUKASAUTI_QVAC_OK')) throw new Error('QVAC returned an unexpected response.');
  console.log('QVAC_INFERENCE_PROOF=PASS');
} catch (error) {
  console.error('QVAC_INFERENCE_PROOF=FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (modelId) await unloadModel({ modelId }).catch(() => {});
}
