const config = require('../config');
const { getPrisma } = require('../db/prisma');
const AuthService = require('../modules/auth/application/AuthService');
const AuthUserRepository = require('../modules/auth/infrastructure/AuthUserRepository');
const PasswordResetTokenRepository = require('../modules/auth/infrastructure/PasswordResetTokenRepository');
const AuthUnitOfWork = require('../modules/auth/infrastructure/AuthUnitOfWork');
const CommentsService = require('../modules/comments/application/CommentsService');
const CommentsRepository = require('../modules/comments/infrastructure/CommentsRepository');
const CommentsContextResolver = require('../modules/comments/infrastructure/CommentsContextResolver');
const IntegrationProcessClient = require('../integrations/remote/IntegrationProcessClient');
const RemoteAuthProvider = require('../integrations/remote/RemoteAuthProvider');
const RemoteSpotfireProvider = require('../integrations/remote/RemoteSpotfireProvider');
const RemoteDeslocamentoRepository = require('../integrations/remote/RemoteDeslocamentoRepository');
const IncidenceRepository = require('../modules/incidences/IncidenceRepository');
const IncidenceService = require('../modules/incidences/IncidenceService');
const DeslocamentoService = require('../modules/deslocamentos/DeslocamentoService');
const { sendPasswordResetEmail, sendNewUserTempPasswordEmail } = require('../server/email/emailService');
const { signSession } = require('../server/middleware/sessionAuth');

function createDependencies() {
  const prisma = getPrisma();
  const integrationRuntime = new IntegrationProcessClient();
  const authProvider = new RemoteAuthProvider(integrationRuntime);
  const incidenceRepo = new IncidenceRepository(authProvider);
  const incidenceService = new IncidenceService(incidenceRepo, 60 * 60 * 1000);

  const spotfireProvider = new RemoteSpotfireProvider(integrationRuntime);
  const deslocamentoRepo = new RemoteDeslocamentoRepository(integrationRuntime);
  const deslocamentoService = new DeslocamentoService(
    deslocamentoRepo,
    spotfireProvider,
    config.spotfire.polos,
  );
  const authUserRepository = new AuthUserRepository(prisma);
  const passwordResetTokenRepository = new PasswordResetTokenRepository(prisma);
  const authUnitOfWork = new AuthUnitOfWork(prisma);
  const authService = new AuthService({
    users: authUserRepository,
    resetTokens: passwordResetTokenRepository,
    transactions: authUnitOfWork,
  }, {
    sendPasswordResetEmail,
    sendNewUserTempPasswordEmail,
    signSession,
  });
  const commentsRepository = new CommentsRepository(prisma);
  const commentsContextResolver = new CommentsContextResolver({ authProvider, deslocamentoService });
  const commentsService = new CommentsService({
    repository: commentsRepository,
    contextResolver: commentsContextResolver,
  });

  return {
    prisma,
    integrationRuntime,
    authProvider,
    authService,
    incidenceService,
    deslocamentoService,
    commentsService,
  };
}

module.exports = { createDependencies };
