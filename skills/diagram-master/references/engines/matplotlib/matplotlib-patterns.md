# Matplotlib 패턴 레퍼런스

## 사용 규칙

1. **plt.savefig() / plt.show() 호출 금지** — 렌더러가 처리
2. **한글 자동 지원** — 별도 설정 불필요
3. **수식**: `r'$\frac{dP}{dQ}$'` 형태로 LaTeX 수식 사용
4. **numpy는 `np`로 사용 가능** — 별도 import 불필요

---

## 패턴 1: 경제학 곡선 (수요/공급)

```python
# supply_demand.py
fig, ax = plt.subplots(figsize=(8, 6))

Q = np.linspace(0, 10, 100)
demand = 12 - Q
supply = 2 + Q

ax.plot(Q, demand, 'b-', linewidth=2.5, label='수요 (D)')
ax.plot(Q, supply, 'r-', linewidth=2.5, label='공급 (S)')

# 균형점
eq_q, eq_p = 5, 7
ax.plot(eq_q, eq_p, 'ko', markersize=8, zorder=5)
ax.annotate(f'균형점\n(Q*={eq_q}, P*={eq_p})', xy=(eq_q, eq_p),
            xytext=(eq_q+1.5, eq_p+1), fontsize=11,
            arrowprops=dict(arrowstyle='->', color='black'))

ax.set_xlabel('수량 (Q)')
ax.set_ylabel('가격 (P)')
ax.set_title('수요-공급 균형')
ax.legend(loc='upper right')
ax.set_xlim(0, 11)
ax.set_ylim(0, 14)
```

## 패턴 2: 확률분포

```python
# distributions.py
from scipy import stats  # scipy는 별도 설치 필요 시 pyproject.toml에 추가

fig, axes = plt.subplots(1, 3, figsize=(15, 5))

# 정규분포
x = np.linspace(-4, 4, 200)
for mu, sigma in [(0, 1), (0, 0.5), (1, 1.5)]:
    axes[0].plot(x, stats.norm.pdf(x, mu, sigma),
                 label=f'μ={mu}, σ={sigma}')
axes[0].set_title('정규분포')
axes[0].legend()

# 포아송
k = np.arange(0, 20)
for lam in [1, 4, 10]:
    axes[1].bar(k + lam*0.15, stats.poisson.pmf(k, lam),
                width=0.4, alpha=0.7, label=f'λ={lam}')
axes[1].set_title('포아송분포')
axes[1].legend()

# 지수분포
x = np.linspace(0, 5, 200)
for lam in [0.5, 1, 2]:
    axes[2].plot(x, stats.expon.pdf(x, scale=1/lam),
                 label=f'λ={lam}')
axes[2].set_title('지수분포')
axes[2].legend()

fig.suptitle('확률분포 비교', fontsize=16, fontweight='bold')
plt.tight_layout()
```

## 패턴 3: 히트맵

```python
# heatmap.py
fig, ax = plt.subplots(figsize=(10, 8))

data = np.random.randn(8, 10)
categories_x = [f'Feature {i+1}' for i in range(10)]
categories_y = [f'Sample {i+1}' for i in range(8)]

im = ax.imshow(data, cmap='RdYlBu_r', aspect='auto')
ax.set_xticks(range(10))
ax.set_xticklabels(categories_x, rotation=45, ha='right')
ax.set_yticks(range(8))
ax.set_yticklabels(categories_y)

# 값 표시
for i in range(8):
    for j in range(10):
        ax.text(j, i, f'{data[i,j]:.1f}', ha='center', va='center',
                color='white' if abs(data[i,j]) > 1.5 else 'black', fontsize=9)

fig.colorbar(im, ax=ax, shrink=0.8)
ax.set_title('Feature Correlation Heatmap')
```

## 패턴 4: Scatter + Regression

```python
# scatter_regression.py
fig, ax = plt.subplots(figsize=(8, 6))

np.random.seed(42)
x = np.random.uniform(0, 10, 50)
y = 2.5 * x + np.random.normal(0, 3, 50) + 5

ax.scatter(x, y, alpha=0.6, s=60, c='#4A90D9', edgecolors='white', linewidth=0.5)

# 회귀선
coeffs = np.polyfit(x, y, 1)
x_fit = np.linspace(0, 10, 100)
ax.plot(x_fit, np.polyval(coeffs, x_fit), 'r--', linewidth=2,
        label=f'y = {coeffs[0]:.1f}x + {coeffs[1]:.1f}')

ax.set_xlabel('Independent Variable')
ax.set_ylabel('Dependent Variable')
ax.set_title('Scatter Plot with Linear Regression')
ax.legend()
```

## 패턴 5: IS-LM 모델 (경제학)

```python
# is_lm.py
fig, ax = plt.subplots(figsize=(8, 6))

Y = np.linspace(0, 20, 200)

# IS curve (우하향)
r_IS = 12 - 0.5 * Y
# LM curve (우상향)
r_LM = -2 + 0.5 * Y

ax.plot(Y, r_IS, 'b-', linewidth=2.5, label='IS')
ax.plot(Y, r_LM, 'r-', linewidth=2.5, label='LM')

# 균형점
eq_Y = 14  # 12 - 0.5Y = -2 + 0.5Y → Y = 14
eq_r = 12 - 0.5 * eq_Y  # r = 5
ax.plot(eq_Y, eq_r, 'ko', markersize=10, zorder=5)
ax.annotate(f'균형 (Y*={eq_Y}, r*={eq_r})',
            xy=(eq_Y, eq_r), xytext=(eq_Y+2, eq_r+1.5),
            fontsize=11, arrowprops=dict(arrowstyle='->', color='black'))

# IS 이동 (재정정책)
r_IS2 = 15 - 0.5 * Y
ax.plot(Y, r_IS2, 'b--', linewidth=1.5, alpha=0.5, label="IS' (재정확대)")
ax.annotate('', xy=(12, 6), xytext=(9, 7.5),
            arrowprops=dict(arrowstyle='->', color='blue', lw=1.5))

ax.set_xlabel('국민소득 (Y)')
ax.set_ylabel('이자율 (r)')
ax.set_title('IS-LM 모델')
ax.legend(loc='upper right')
ax.set_xlim(0, 22)
ax.set_ylim(-2, 16)
ax.axhline(y=0, color='gray', linewidth=0.5)
ax.axvline(x=0, color='gray', linewidth=0.5)
```

## 패턴 6: 3D Surface

```python
# surface_3d.py
fig = plt.figure(figsize=(10, 7))
ax = fig.add_subplot(111, projection='3d')

x = np.linspace(-3, 3, 100)
y = np.linspace(-3, 3, 100)
X, Y = np.meshgrid(x, y)
Z = np.sin(np.sqrt(X**2 + Y**2))

surf = ax.plot_surface(X, Y, Z, cmap='viridis', alpha=0.8,
                       edgecolor='none', antialiased=True)
fig.colorbar(surf, shrink=0.5, aspect=10)

ax.set_xlabel('X')
ax.set_ylabel('Y')
ax.set_zlabel('Z')
ax.set_title(r'$z = \sin(\sqrt{x^2 + y^2})$')
ax.view_init(elev=30, azim=45)
```

## 패턴 7: 서브플롯 그리드

```python
# multi_panel.py
fig, axes = plt.subplots(2, 2, figsize=(12, 10))

# 각 패널에 개별 차트
x = np.linspace(0, 2*np.pi, 100)

axes[0,0].plot(x, np.sin(x), 'b-', linewidth=2)
axes[0,0].set_title(r'$y = \sin(x)$')

axes[0,1].plot(x, np.cos(x), 'r-', linewidth=2)
axes[0,1].set_title(r'$y = \cos(x)$')

axes[1,0].plot(x, np.exp(-x/3) * np.sin(x), 'g-', linewidth=2)
axes[1,0].set_title(r'$y = e^{-x/3}\sin(x)$')

axes[1,1].plot(x, np.log(x + 1), 'm-', linewidth=2)
axes[1,1].set_title(r'$y = \ln(x+1)$')

for ax_row in axes:
    for ax in ax_row:
        ax.grid(True, alpha=0.3)

fig.suptitle('수학 함수 패널', fontsize=16, fontweight='bold')
plt.tight_layout()
```

## 스타일 추천

| 용도 | 스타일 | 명령 |
|------|--------|------|
| 학술 논문 | 기본 (흰배경) | `--style default` |
| 프레젠테이션 | 어두운 배경 | `--style dark_background` |
| 통계 보고서 | seaborn 스타일 | `--style seaborn-v0_8` |
| 깔끔한 차트 | ggplot 스타일 | `--style ggplot` |

## 색상 팔레트 추천

| 팔레트 | 용도 |
|--------|------|
| `tab10` | 범주형 데이터 (≤10개) |
| `Set2` | 부드러운 범주형 |
| `viridis` | 연속형 데이터 (접근성 우수) |
| `RdYlBu_r` | 발산형 (양극 비교) |
| `coolwarm` | 상관관계 히트맵 |
