/**
 * AI Director — manages the AI job queue and orchestrates the DM's responses.
 * Processes one job at a time (Ollama is single-threaded on Pi).
 * Priority queue ensures player-facing requests are handled first.
 */

import { v4 as uuid } from 'uuid';
import { generate, chat, quickGenerate } from './ollama.js';
import { DM_SYSTEM_PROMPT } from './prompts.js';
import { getDb } from '../db/schema.js';
import { run } from '../db/helpers.js';

export interface AIJob {
  id: string;
  campaignId: string | null;
  type: 'scene' | 'npc_dialogue' | 'combat_narration' | 'story_react' | 'encounter_design' | 'ruling' | 'world_gen';
  priority: number;  // 1 = urgent (player waiting), 5 = background pre-gen
  prompt: string;
  system?: string;
  format?: 'json';
  model?: string;
  status: 'queued' | 'generating' | 'complete' | 'failed';
  result?: string;
  createdAt: string;
  completedAt?: string;
  callback?: (result: string) => void;
}

class AIDirector {
  private queue: AIJob[] = [];
  private processing = false;
  private conversationHistory: Map<string, { role: string; content: string }[]> = new Map();

  /** Add a job to the queue */
  enqueue(params: {
    campaignId?: string;
    type: AIJob['type'];
    priority?: number;
    prompt: string;
    system?: string;
    format?: 'json';
    model?: string;
    callback?: (result: string) => void;
  }): string {
    const job: AIJob = {
      id: uuid(),
      campaignId: params.campaignId || null,
      type: params.type,
      priority: params.priority ?? 3,
      prompt: params.prompt,
      system: params.system,
      format: params.format,
      model: params.model,
      status: 'queued',
      createdAt: new Date().toISOString(),
      callback: params.callback,
    };

    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority); // Lower priority number = first

    // Persist to DB
    this.persistJob(job);

    // Start processing if not already running
    if (!this.processing) {
      this.processNext();
    }

    return job.id;
  }

  /** Enqueue and wait for the result */
  async enqueueAndWait(params: {
    campaignId?: string;
    type: AIJob['type'];
    priority?: number;
    prompt: string;
    system?: string;
    format?: 'json';
    model?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      this.enqueue({
        ...params,
        callback: (result) => resolve(result),
      });
    });
  }

  /** Process the next job in the queue */
  private async processNext() {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const job = this.queue.shift()!;
    job.status = 'generating';
    this.persistJob(job);

    try {
      const system = job.system || DM_SYSTEM_PROMPT;

      let result: string;
      if (job.format === 'json') {
        // Use generate mode for structured output
        result = await generate({
          prompt: job.prompt,
          system,
          model: job.model,
          format: 'json',
          temperature: 0.7,
        });
      } else if (job.campaignId && this.conversationHistory.has(job.campaignId)) {
        // Use chat mode with history for ongoing campaigns
        const history = this.conversationHistory.get(job.campaignId)!;
        history.push({ role: 'user', content: job.prompt });

        // Keep conversation history manageable (last 20 exchanges)
        if (history.length > 40) {
          history.splice(0, history.length - 40);
        }

        result = await chat({
          messages: [
            { role: 'system', content: system },
            ...history,
          ],
          model: job.model,
        });

        history.push({ role: 'assistant', content: result });
      } else {
        // Simple generation
        result = await generate({
          prompt: job.prompt,
          system,
          model: job.model,
        });

        // Start conversation history for this campaign
        if (job.campaignId) {
          this.conversationHistory.set(job.campaignId, [
            { role: 'user', content: job.prompt },
            { role: 'assistant', content: result },
          ]);
        }
      }

      job.status = 'complete';
      job.result = result;
      job.completedAt = new Date().toISOString();
      this.persistJob(job);

      if (job.callback) {
        job.callback(result);
      }
    } catch (err) {
      job.status = 'failed';
      job.result = err instanceof Error ? err.message : 'Unknown error';
      job.completedAt = new Date().toISOString();
      this.persistJob(job);

      console.error(`[AI Director] Job ${job.id} failed:`, err);

      if (job.callback) {
        job.callback(`[The DM pauses, lost in thought for a moment...] (AI generation failed: ${job.result})`);
      }
    }

    // Process next job
    this.processNext();
  }

  /** Get queue status */
  getStatus(): { queueLength: number; processing: boolean; currentJob?: string } {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentJob: this.processing ? this.queue[0]?.type : undefined,
    };
  }

  /** Clear conversation history for a campaign (e.g., new session) */
  resetCampaignContext(campaignId: string) {
    this.conversationHistory.delete(campaignId);
  }

  /** Persist job to DB */
  private persistJob(job: AIJob) {
    try {
      const db = getDb();
      run(db, `
        INSERT OR REPLACE INTO ai_queue (id, campaign_id, type, priority, prompt, context, status, result, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        job.id, job.campaignId, job.type, job.priority,
        job.prompt, job.system || '', job.status, job.result || null,
        job.createdAt, job.completedAt || null,
      ]);
    } catch {
      // Non-critical — don't crash if DB persistence fails
    }
  }
}

// Singleton
export const aiDirector = new AIDirector();
