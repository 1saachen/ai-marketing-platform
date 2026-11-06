import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { expect, it } from 'vitest';
import { ActivateCustomizedBranchDto } from './dto/activate-customized-branch.dto';
it('accepts omitted viewing intent for old clients and validates current/history navigation', async () => {
  for (const value of [
    {},
    { informationMode: 'CURRENT' },
    { informationMode: 'HISTORICAL' },
    { informationMode: 'PRESERVE' },
  ]) {
    expect(
      await validate(plainToInstance(ActivateCustomizedBranchDto, value), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toEqual([]);
  }
  for (const value of [
    { informationMode: 'latest-from-any-project' },
    { informationMode: 1 },
    { informationMode: 'CURRENT', projectId: 'other' },
  ]) {
    expect(
      (
        await validate(plainToInstance(ActivateCustomizedBranchDto, value), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length,
    ).toBeGreaterThan(0);
  }
});
