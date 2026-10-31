"""Logistic regression (numpy Newton) on a few features: fit on one case, test on the other.
python3 logit.py s1212 s1749"""
import sys

import numpy as np

from score import auc

FEATS = ['dist_T600', 'close_T600_R12', 'gmag', 'resid_std_r3', 'bandfrac_R5', 'hess_l1_s3']


def design(d):
  X = np.stack([d[k].astype(np.float64) for k in FEATS], 1)
  X[:, 0] = np.log1p(X[:, 0])
  return X


def fit(X, y, iters=25):
  X = np.hstack([X, np.ones((len(X), 1))])
  w = np.zeros(X.shape[1])
  for _ in range(iters):
    p = 1 / (1 + np.exp(-X @ w))
    g = X.T @ (p - y)
    H = (X * (p * (1 - p))[:, None]).T @ X + 1e-3 * np.eye(len(w))
    w -= np.linalg.solve(H, g)
  return w


def evaluate(w, X, cat, mu, sd):
  X = np.hstack([(X - mu) / sd, np.ones((len(X), 1))])
  s = X @ w
  v = s[cat == 1]; thr = np.quantile(v, 0.1)
  return auc(v, s[cat >= 3]), {n: round(float((s[cat == c] < thr).mean()), 3) for c, n in {4: 'int', 3: 'bnd', 2: 'heart', 0: 'other'}.items()}


if __name__ == '__main__':
  a, b = (np.load(f'/Users/chris/src/mono/scratch/fable-study/{c}.npz') for c in sys.argv[1:3])
  for train, test, tn, sn in ((a, b, sys.argv[1], sys.argv[2]), (b, a, sys.argv[2], sys.argv[1])):
    Xt, ct = design(train), train['cat']
    sel = (ct == 1) | (ct >= 3)
    mu, sd = Xt[sel].mean(0), Xt[sel].std(0) + 1e-9
    w = fit((Xt[sel] - mu) / sd, (ct[sel] == 1).astype(float))
    print(f'train {tn} -> test {sn}: weights', dict(zip(FEATS + ['b'], w.round(2))))
    print('   train AUC/removed@90%:', evaluate(w, Xt, ct, mu, sd))
    print('   test  AUC/removed@90%:', evaluate(w, design(test), test['cat'], mu, sd))
    w1 = fit(((Xt[sel] - mu) / sd)[:, :1], (ct[sel] == 1).astype(float))
    print('   dist only test AUC:', evaluate(np.r_[w1[0], np.zeros(len(FEATS) - 1), w1[1]], design(test), test['cat'], mu, sd)[0].round(3))
