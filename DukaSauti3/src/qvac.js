const SYSTEM_PROMPT = `You extract shop bookkeeping events from English notes. Return ONLY valid JSON matching {"events":[{"type":"sale|expense|stock_purchase|customer_payment|supplier_payment|cash_withdrawal|cash_deposit|refund|opening_balance|adjustment","description":"string","amount_minor":integer,"currency":"KES","payment_method":"cash|mobile_money|bank|credit|mixed|other|none","cash_received_minor":integer,"mobile_money_received_minor":integer,"bank_received_minor":integer,"cash_paid_minor":integer,"credit_amount_minor":integer,"business_date":"YYYY-MM-DD","notes":"string"}],"questions":["string"],"status":"needs_confirmation"}. Convert KES to minor units (multiply by 100). Never invent amounts, dates, customer identities or payment methods. If information is ambiguous, put a question in questions. All entries require human confirmation. Do not calculate profit.`;

export class QvacService {
  constructor() { this.modelId = null; this.sdk = null; this.ready = false; this.lastError = null; }
  async load() {
    if (this.ready) return { ready: true };
    try {
      this.sdk = await import('@qvac/sdk');
      const modelSrc = this.sdk.LLAMA_3_2_1B_INST_Q4_0;
      if (!modelSrc) throw new Error('QVAC model constant LLAMA_3_2_1B_INST_Q4_0 is unavailable in the installed SDK.');
      this.modelId = await this.sdk.loadModel({ modelSrc });
      this.ready = true;
      this.lastError = null;
      return { ready: true };
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.ready = false;
      throw new Error(`QVAC is not ready: ${this.lastError}`);
    }
  }
  async extract(note) {
    if (!this.ready || !this.modelId) throw new Error('QVAC model is not loaded. Use manual entry or load the model first.');
    const result = await this.sdk.completion({ modelId: this.modelId, history: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nShop note:\n${note}` }], stream: true });
    let raw = result?.text ?? result?.content ?? result?.completion;
    if (!raw && result?.tokenStream) {
      raw = '';
      for await (const token of result.tokenStream) raw += typeof token === 'string' ? token : (token?.text ?? '');
    }
    if (typeof raw !== 'string') throw new Error('QVAC returned an unexpected response format.');
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.questions)) throw new Error('QVAC response does not match the expected schema.');
    return { ...parsed, source_text: note, parser: 'qvac-local' };
  }
  status() { return { configured: true, ready: this.ready, model: 'LLAMA_3_2_1B_INST_Q4_0', error: this.lastError, note: this.ready ? 'Model loaded in local QVAC runtime.' : 'Model is not loaded; offline AI is not available yet.' }; }
  async close() { if (this.modelId && this.sdk?.unloadModel) await this.sdk.unloadModel({ modelId: this.modelId }); this.modelId = null; this.ready = false; if (this.sdk?.close) await this.sdk.close(); }
}
