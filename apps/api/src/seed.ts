import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const whatsappPhone = process.env.TEST_WHATSAPP_PHONE || "5599999999999";

  const client = await prisma.client.upsert({
    where: { slug: "panoram-demo" },
    update: {},
    create: {
      name: "Panoram Demo",
      slug: "panoram-demo",
    },
  });

  await prisma.trackingLink.upsert({
    where: { slug: "teste-whatsapp" },
    update: {
      whatsappPhone,
      whatsappInitialMessage: "Olá, vi o anúncio e quero saber mais.",
      isActive: true,
    },
    create: {
      clientId: client.id,
      slug: "teste-whatsapp",
      name: "Teste WhatsApp",
      sourcePlatform: "meta",
      campaignName: "Campanha Teste",
      whatsappPhone,
      whatsappInitialMessage: "Olá, vi o anúncio e quero saber mais.",
      isActive: true,
    },
  });

  console.log("Seed concluído com sucesso.");
  console.log(`Tracking link criado: /r/teste-whatsapp`);
  console.log(`WhatsApp destino: ${whatsappPhone}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
