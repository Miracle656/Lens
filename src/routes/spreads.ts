import type { FastifyInstance } from 'fastify';
import { pgPool } from '../db';

/**
 * GET /spreads/:asset - Return current bid, ask, and spread (bps) for the given asset.
 * The bid is taken as the highest price among price points where the asset appears.
 * The ask is the lowest price among those points.
 * Spread basis points = ((ask - bid) / ask) * 10_000.
 */
export async function registerSpreadsRoutes(app: FastifyInstance) {
  app.get('/spreads/:asset', async (req, reply) => {
    const { asset } = req.params as { asset: string };
    if (!asset) {
      return reply.status(400).send({ error: 'Asset parameter is required' });
    }

    const result = await pgPool.query(
      `SELECT MAX(price::numeric) AS bid, MIN(price::numeric) AS ask
       FROM price_points
       WHERE assetA = $1 OR assetB = $1`,
      [asset]
    );
    const row = result.rows[0];
    const bid = row.bid !== null ? parseFloat(row.bid) : null;
    const ask = row.ask !== null ? parseFloat(row.ask) : null;
    let spreadBps: number | null = null;
    if (bid !== null && ask !== null && ask !== 0) {
      spreadBps = ((ask - bid) / ask) * 10_000;
    }
    return { asset, bid, ask, spreadBps };
  });
}
