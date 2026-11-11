const sampleProducts = [
  { title: '손으로 빚은 찻잔', price: '28,000원', material: '백자 · 유약 마감' },
  { title: '작은 화병', price: '36,000원', material: '분청 · 손잡이 성형' },
];

export default function ShopPage() {
  return (
    <main>
      <header>
        <p>작은 공방의 온라인 가게</p>
        <h1>오래 곁에 두는 물건</h1>
        <p>손으로 만들고 천천히 소개합니다.</p>
      </header>
      <section aria-labelledby="products-heading">
        <h2 id="products-heading">공방의 상품</h2>
        <p role="note">예시 상품입니다. 실제 상품은 Nexus 백엔드의 listProducts RPC를 화면에 연결한 뒤 표시됩니다.</p>
        <ul>
          {sampleProducts.map((product) => (
            <li key={product.title}>
              <article>
                <h3>{product.title}</h3>
                <p>{product.material}</p>
                <p>{product.price}</p>
              </article>
            </li>
          ))}
        </ul>
        <p>상품 등록과 공개 목록은 app.yaml의 Nexus RPC 계약을 사용하고, 사진 키는 apps/shop-studio/ 아래에 저장됩니다.</p>
      </section>
    </main>
  );
}
