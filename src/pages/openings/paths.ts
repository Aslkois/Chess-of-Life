export const pathParam = (ucis: string[]) => ucis.join(',');
export const parsePathParam = (s: string) => s.split(',').filter((u) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u));
