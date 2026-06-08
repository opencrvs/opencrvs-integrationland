/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * OpenCRVS is also distributed under the terms of the Civil Registration
 * & Healthcare Disclaimer located at http://opencrvs.org/license.
 *
 * Copyright (C) The OpenCRVS Authors located at https://github.com/opencrvs/opencrvs-core/blob/master/AUTHORS.
 */
import * as Hapi from '@hapi/hapi'
import { eventConfigs } from '@countryconfig/events'
import { sendInformantNotification } from '../notification/informantNotification'
import { ActionConfirmationRequest } from '../registration'
import { createMosipInteropClient } from '@opencrvs/mosip/api'
import {
  Action,
  ActionType,
  aggregateActionDeclarations,
  deepMerge,
  getPendingAction,
  RegisterAction,
  NameFieldValue
} from '@opencrvs/toolkit/events'
import { MOSIP_INTEROP_URL } from '@countryconfig/constants'
import {
  getBirthInformantSection,
  getInformantPsut,
  shouldForwardBirthRegistrationToMosip
} from '../../events/mosip'
import { logger } from '@countryconfig/logger'
import { capitalize } from 'lodash'

export function getEventsHandler(_: Hapi.Request, h: Hapi.ResponseToolkit) {
  return h.response(eventConfigs).code(200)
}

export async function onCustomActionHandler(
  _: ActionConfirmationRequest,
  h: Hapi.ResponseToolkit
) {
  return h.response().code(200)
}

/**
 * This catch-all action route will receive event actions with `Content-Type: application/json`
 */
export async function onAnyActionHandler(
  request: ActionConfirmationRequest,
  h: Hapi.ResponseToolkit
) {
  const token = request.auth.artifacts.token as string
  const event = request.payload

  await sendInformantNotification({ event, token })

  return h.response().code(200)
}

export async function onBirthActionHandler(
  request: ActionConfirmationRequest,
  h: Hapi.ResponseToolkit
) {
  const token = request.auth.artifacts.token as string
  const event = request.payload
  await sendInformantNotification({ event, token })

  const pendingAction = getPendingAction(event.actions)

  if (
    pendingAction.type === ActionType.CUSTOM &&
    pendingAction.customActionType === 'REVOKE_REGISTRATION'
  ) {
    console.log(
      'Country config would call revocation endpoint, but it is not implemented in MOSIP yet'
    )

    return h.response({ declaration: { 'child.nid': null } }).code(200)
  }

  const declaration = deepMerge(
    aggregateActionDeclarations(event),
    pendingAction.declaration
  )

  const mosipInteropClient = createMosipInteropClient(
    MOSIP_INTEROP_URL,
    `Bearer ${token}`
  )

  const updatedFields: Record<string, 'verified' | 'failed'> = {}

  // const isMotherAvailable =
  //   declaration['mother.dob'] &&
  //   declaration['mother.nid'] &&
  //   declaration['mother.name']

  // if (isMotherAvailable && declaration['mother.verified'] !== 'authenticated') {
  //   updatedFields['mother.verified'] = await mosipInteropClient.verifyNid({
  //     dob: declaration['mother.dob'],
  //     nid: declaration['mother.nid'],
  //     name: declaration['mother.name'],
  //     gender: 'female',
  //     transactionId: `mother-${event.id}`
  //   })
  // }

  // const isFatherAvailable =
  //   declaration['father.dob'] &&
  //   declaration['father.nid'] &&
  //   declaration['father.name']

  // if (isFatherAvailable && declaration['father.verified'] !== 'authenticated')
  //   updatedFields['father.verified'] = await mosipInteropClient.verifyNid({
  //     dob: declaration['father.dob'],
  //     nid: declaration['father.nid'],
  //     name: declaration['father.name'],
  //     gender: 'male',
  //     transactionId: `father-${event.id}`
  //   })

  // const isInformantAvailable =
  //   declaration['informant.dob'] &&
  //   declaration['informant.nid'] &&
  //   declaration['informant.name']

  // if (
  //   isInformantAvailable &&
  //   declaration['informant.verified'] !== 'authenticated'
  // )
  //   updatedFields['informant.verified'] = await mosipInteropClient.verifyNid({
  //     dob: declaration['informant.dob'],
  //     nid: declaration['informant.nid'],
  //     name: declaration['informant.name'],
  //     transactionId: `informant-${event.id}`
  //   })

  return h.response({ declaration: updatedFields }).code(200)
}

const getAcceptedBirthRegistrationNumber = (actions: Action[]) => {
  const acceptedRegisterAction = actions.find(
    ({ type, status }) => type === ActionType.REGISTER && status === 'Accepted'
  ) as RegisterAction | undefined

  // `APPROVE_CORRECTION` is only available when the event has been registered
  return acceptedRegisterAction!.registrationNumber!
}

export async function onBirthCorrectionActionHandler(
  request: ActionConfirmationRequest,
  h: Hapi.ResponseToolkit
) {
  const token = request.auth.artifacts.token as string
  const event = request.payload
  await sendInformantNotification({ event, token })
  const pendingAction = getPendingAction(event.actions)
  const declaration = deepMerge(
    aggregateActionDeclarations(event),
    pendingAction.declaration
  )

  const childHasNid = Boolean(declaration['child.nid'])
  const shouldForwardToMosip =
    shouldForwardBirthRegistrationToMosip(declaration)

  if (!shouldForwardToMosip) {
    logger.info(
      'Birth registration correction will not be forwarded to MOSIP based on custom logic.'
    )

    return h.response({}).code(200)
  }

  logger.info(
    'Passed country specified custom logic check for birth correction. Forwarding to MOSIP...'
  )
  const birthCertificateNumber = getAcceptedBirthRegistrationNumber(
    event.actions
  )
  const mosipInteropClient = createMosipInteropClient(
    MOSIP_INTEROP_URL,
    `Bearer ${token}`
  )
  const childName = declaration['child.name'] as NameFieldValue

  const childIdentifier = declaration['child.nid'] as string | undefined
  const birthInformantSection = getBirthInformantSection(
    declaration['informant.relation'] as string
  )
  const introducerInfoToken = getInformantPsut(
    declaration,
    birthInformantSection
  )

  try {
    if (!childHasNid) {
      await mosipInteropClient.register({
        trackingId: event.trackingId,
        requestFields: {
          birthCertificateNumber,
          fullName:
            '[ {\n  "language" : "eng",\n  "value" : "' +
            [childName?.firstname, childName?.middlename, childName?.surname]
              .filter(Boolean)
              .join(' ') +
            '"\n}]',

          dateOfBirth: declaration['child.dob']
            ?.toString()
            .replaceAll('-', '/'),
          gender:
            '[ {\n  "language" : "eng",\n  "value" : "' +
            capitalize(declaration['child.gender'] as string) +
            '"\n}]',
          postalCode: '14022',
          email: 'rachik.sharma@gmail.com',
          phone: '7790075085',
          zone: '[ {\n  "language" : "eng",\n  "value" : "Ben Mansour"\n}]',
          region:
            '[ {\n  "language" : "eng",\n  "value" : "Rabat Sale Kenitra"\n}]',
          province: '[ {\n  "language" : "eng",\n  "value" : "Kenitra"\n}]',
          preferredLang: 'English'
        },
        notification: {
          recipientEmail: 'rachik.sharma@gmail.com',
          recipientFullName: 'Rachik Sharma',
          recipientPhone: '7790075085'
        },
        metaInfo: {
          metaData:
            '[{\n  "label" : "registrationType",\n  "value" : "NEW"\n}, {\n  "label" : "machineId",\n  "value" : "20042"\n}, {\n  "label" : "centerId",\n  "value" : "10001"\n}]',
          registrationId: '10001100620007420250522121835',
          operationsData:
            '[ {\n  "label" : "officerId",\n  "value" : "crvs1"\n}, {\n  "label" : "officerBiometricFileName",\n  "value" : null\n}, {\n  "label" : "supervisorId",\n  "value" : null\n}, {\n  "label" : "supervisorBiometricFileName",\n  "value" : null\n}, {\n  "label" : "supervisorPassword",\n  "value" : "false"\n}, {\n  "label" : "officerPassword",\n  "value" : "true"\n}, {\n  "label" : "supervisorPIN",\n  "value" : null\n}, {\n  "label" : "officerPIN",\n  "value" : null\n}, {\n  "label" : "supervisorOTPAuthentication",\n  "value" : "false"\n}, {\n  "label" : "officerOTPAuthentication",\n  "value" : "false"\n} ]',
          capturedRegisteredDevices: '[]',
          creationDate: '20250225110733'
        },
        audit: {
          uuid: 'c75s4521-87d6-6a4x-balw-2432e2355440',
          createdAt: '2025-02-25T13:22:49.214Z',
          eventId: 'REG-EVT-066',
          eventName: 'PACKET_CREATION_SUCCESS',
          eventType: 'USER',
          hostName: 'DESKTOP-JL4BAEV',
          hostIp: 'localhost',
          applicationId: 'REG',
          applicationName: 'REGISTRATION',
          sessionUserId: 'crvs',
          sessionUserName: 'crvs',
          id: '10001100620007420250522121835',
          idType: 'REGISTRATION_ID',
          createdBy: 'crvs',
          moduleName: 'Packet Handler',
          moduleId: 'REG-MOD-117',
          description: 'Packet Succesfully Created',
          actionTimeStamp: '2025-02-25T07:52:49.214Z'
        },
        schemaJson: `{"$schema":"http://json-schema.org/draft-07/schema#","description":"SL Identity schema","additionalProperties":false,"title":"SL Identity schema","type":"object","definitions":{"simpleType":{"uniqueItems":true,"additionalItems":false,"type":"array","items":{"additionalProperties":false,"type":"object","required":["language","value"],"properties":{"language":{"type":"string"},"value":{"type":"string"}}}},"documentType":{"additionalProperties":false,"type":"object","required":["format","type","value"],"properties":{"refNumber":{"type":["string","null"]},"format":{"type":"string"},"type":{"type":"string"},"value":{"type":"string"}}},"biometricsType":{"additionalProperties":false,"type":"object","properties":{"format":{"type":"string"},"version":{"type":"number","minimum":0},"value":{"type":"string"}}}},"properties":{"identity":{"additionalProperties":false,"type":"object","required":["IDSchemaVersion","fullName","dateOfBirth","gender","permanentAddress","email","individualBiometrics"],"properties":{"printedName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"shortenedPrintedName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"proofOfAddress":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"layName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"fatherName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"gender":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"city":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"postalCode":{"bioAttributes":[],"validators":[{"validator":"^[(?i)A-Z0-9]{5}$|^NA$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"individualBiometrics":{"bioAttributes":["leftEye","rightEye","rightIndex","rightLittle","rightRing","rightMiddle","leftIndex","leftLittle","leftRing","leftMiddle","leftThumb","rightThumb","face"],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/biometricsType"},"province":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"nationalIdentityNumber":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^([0-9]{9}[x|X|v|V]|[0-9]{12})$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"kyc","type":"string","fieldType":"default"},"zone":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"proofOfDateOfBirth":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"residenceStatus":{"bioAttributes":[],"fieldCategory":"kyc","format":"none","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"permanentAddress":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"temporaryAddress":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"email":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^[A-Za-z0-9_\\\\-]+(\\\\.[A-Za-z0-9_]+)*@[A-Za-z0-9_-]+(\\\\.[A-Za-z0-9_]+)*(\\\\.[a-zA-Z]{2,})$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"profession":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"introducerRID":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","type":"string","fieldType":"default"},"introducerBiometrics":{"bioAttributes":["leftEye","rightEye","rightIndex","rightLittle","rightRing","rightMiddle","leftIndex","leftLittle","leftRing","leftMiddle","leftThumb","rightThumb","face"],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/biometricsType"},"fullName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"dateOfBirth":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(1869|18[7-9][0-9]|19[0-9][0-9]|20[0-9][0-9])/([0][1-9]|1[0-2])/([0][1-9]|[1-2][0-9]|3[01])$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"individualAuthBiometrics":{"bioAttributes":["leftEye","rightEye","rightIndex","rightLittle","rightRing","rightMiddle","leftIndex","leftLittle","leftRing","leftMiddle","leftThumb","rightThumb","face"],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/biometricsType"},"introducerUIN":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","type":"string","fieldType":"default"},"proofOfIdentity":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"IDSchemaVersion":{"bioAttributes":[],"fieldCategory":"none","format":"none","type":"number","fieldType":"default","minimum":0},"proofOfException":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"phone":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^[+]*([0-9]{1})([0-9]{9})$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"introducerName":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"proofOfRelationship":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"UIN":{"bioAttributes":[],"fieldCategory":"none","format":"none","type":"string","fieldType":"default"},"region":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"maritalStatus":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"modeOfdelivery":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"dualCitizenshipAvailability":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"preferredLang":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"dynamic"}}}}}`
      })
      return h.response({}).code(202)
    }

    await mosipInteropClient
      .updateBiographics({
        trackingId: event.trackingId,
        requestFields: {
          VID: childIdentifier!,
          fullName: [
            childName.firstname,
            childName.middlename,
            childName.surname
          ]
            .filter(Boolean)
            .join(' '),
          dateOfBirth: declaration['child.dob'] as string,
          gender: declaration['child.gender'] as string,
          introducerInfoToken
        },
        notification: {
          recipientEmail: 'rachik.sharma@gmail.com',
          recipientFullName: 'Rachik Sharma',
          recipientPhone: '7790075085'
        },
        metaInfo: {
          metaData:
            '[{\n  "label" : "registrationType",\n  "value" : "NEW"\n}, {\n  "label" : "machineId",\n  "value" : "20042"\n}, {\n  "label" : "centerId",\n  "value" : "10001"\n}]',
          registrationId: '10001100620007420250522121835',
          operationsData:
            '[ {\n  "label" : "officerId",\n  "value" : "crvs1"\n}, {\n  "label" : "officerBiometricFileName",\n  "value" : null\n}, {\n  "label" : "supervisorId",\n  "value" : null\n}, {\n  "label" : "supervisorBiometricFileName",\n  "value" : null\n}, {\n  "label" : "supervisorPassword",\n  "value" : "false"\n}, {\n  "label" : "officerPassword",\n  "value" : "true"\n}, {\n  "label" : "supervisorPIN",\n  "value" : null\n}, {\n  "label" : "officerPIN",\n  "value" : null\n}, {\n  "label" : "supervisorOTPAuthentication",\n  "value" : "false"\n}, {\n  "label" : "officerOTPAuthentication",\n  "value" : "false"\n} ]',
          capturedRegisteredDevices: '[]',
          creationDate: '20250225110733'
        },
        audit: {
          uuid: 'c75s4521-87d6-6a4x-balw-2432e2355440',
          createdAt: '2025-02-25T13:22:49.214Z',
          eventId: 'REG-EVT-066',
          eventName: 'PACKET_CREATION_SUCCESS',
          eventType: 'USER',
          hostName: 'DESKTOP-JL4BAEV',
          hostIp: 'localhost',
          applicationId: 'REG',
          applicationName: 'REGISTRATION',
          sessionUserId: 'crvs',
          sessionUserName: 'crvs',
          id: '10001100620007420250522121835',
          idType: 'REGISTRATION_ID',
          createdBy: 'crvs',
          moduleName: 'Packet Handler',
          moduleId: 'REG-MOD-117',
          description: 'Packet Succesfully Created',
          actionTimeStamp: '2025-02-25T07:52:49.214Z'
        },
        schemaJson: `{"$schema":"http://json-schema.org/draft-07/schema#","description":"SL Identity schema","additionalProperties":false,"title":"SL Identity schema","type":"object","definitions":{"simpleType":{"uniqueItems":true,"additionalItems":false,"type":"array","items":{"additionalProperties":false,"type":"object","required":["language","value"],"properties":{"language":{"type":"string"},"value":{"type":"string"}}}},"documentType":{"additionalProperties":false,"type":"object","required":["format","type","value"],"properties":{"refNumber":{"type":["string","null"]},"format":{"type":"string"},"type":{"type":"string"},"value":{"type":"string"}}},"biometricsType":{"additionalProperties":false,"type":"object","properties":{"format":{"type":"string"},"version":{"type":"number","minimum":0},"value":{"type":"string"}}}},"properties":{"identity":{"additionalProperties":false,"type":"object","required":["IDSchemaVersion","fullName","dateOfBirth","gender","permanentAddress","email","individualBiometrics"],"properties":{"printedName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"shortenedPrintedName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"proofOfAddress":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"layName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"fatherName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"gender":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"city":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"postalCode":{"bioAttributes":[],"validators":[{"validator":"^[(?i)A-Z0-9]{5}$|^NA$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"individualBiometrics":{"bioAttributes":["leftEye","rightEye","rightIndex","rightLittle","rightRing","rightMiddle","leftIndex","leftLittle","leftRing","leftMiddle","leftThumb","rightThumb","face"],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/biometricsType"},"province":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"nationalIdentityNumber":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^([0-9]{9}[x|X|v|V]|[0-9]{12})$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"kyc","type":"string","fieldType":"default"},"zone":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"proofOfDateOfBirth":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"residenceStatus":{"bioAttributes":[],"fieldCategory":"kyc","format":"none","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"permanentAddress":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"temporaryAddress":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"email":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^[A-Za-z0-9_\\\\-]+(\\\\.[A-Za-z0-9_]+)*@[A-Za-z0-9_-]+(\\\\.[A-Za-z0-9_]+)*(\\\\.[a-zA-Z]{2,})$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"profession":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"introducerRID":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","type":"string","fieldType":"default"},"introducerBiometrics":{"bioAttributes":["leftEye","rightEye","rightIndex","rightLittle","rightRing","rightMiddle","leftIndex","leftLittle","leftRing","leftMiddle","leftThumb","rightThumb","face"],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/biometricsType"},"fullName":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{3,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"dateOfBirth":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(1869|18[7-9][0-9]|19[0-9][0-9]|20[0-9][0-9])/([0][1-9]|1[0-2])/([0][1-9]|[1-2][0-9]|3[01])$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"individualAuthBiometrics":{"bioAttributes":["leftEye","rightEye","rightIndex","rightLittle","rightRing","rightMiddle","leftIndex","leftLittle","leftRing","leftMiddle","leftThumb","rightThumb","face"],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/biometricsType"},"introducerUIN":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","type":"string","fieldType":"default"},"proofOfIdentity":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"IDSchemaVersion":{"bioAttributes":[],"fieldCategory":"none","format":"none","type":"number","fieldType":"default","minimum":0},"proofOfException":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"phone":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^[+]*([0-9]{1})([0-9]{9})$","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"default"},"introducerName":{"bioAttributes":[],"fieldCategory":"evidence","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"proofOfRelationship":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/documentType"},"UIN":{"bioAttributes":[],"fieldCategory":"none","format":"none","type":"string","fieldType":"default"},"region":{"bioAttributes":[],"validators":[{"langCode":null,"validator":"^(?=.{0,50}$).*","arguments":[],"type":"regex"}],"fieldCategory":"pvt","format":"none","fieldType":"default","$ref":"#/definitions/simpleType"},"maritalStatus":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"modeOfdelivery":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"dualCitizenshipAvailability":{"bioAttributes":[],"fieldCategory":"pvt","format":"","fieldType":"dynamic","$ref":"#/definitions/simpleType"},"preferredLang":{"bioAttributes":[],"fieldCategory":"pvt","format":"none","type":"string","fieldType":"dynamic"}}}}}`
      })
      .catch((error) => {
        logger.error(
          { eventId: event.id, err: error },
          'Failed to send birth correction biographic update to MOSIP'
        )
      })

    return h.response({}).code(200)
  } catch (error) {
    logger.error(
      { eventId: event.id, err: error },
      'Failed to forward birth correction approval to MOSIP'
    )

    return h
      .response({
        reason: 'Unexpected error in OpenCRVS-MOSIP interoperability layer'
      })
      .code(400)
  }
}

export async function onDeathActionHandler(
  request: ActionConfirmationRequest,
  h: Hapi.ResponseToolkit
) {
  const token = request.auth.artifacts.token as string
  const event = request.payload
  await sendInformantNotification({ event, token })

  const pendingAction = getPendingAction(event.actions)
  const declaration = deepMerge(
    aggregateActionDeclarations(event),
    pendingAction.declaration
  )

  const mosipInteropClient = createMosipInteropClient(
    MOSIP_INTEROP_URL,
    `Bearer ${token}`
  )

  const updatedFields: Record<string, 'verified' | 'failed'> = {}

  // const isDeceasedAvailable =
  //   declaration['deceased.dob'] &&
  //   declaration['deceased.nid'] &&
  //   declaration['deceased.name']

  // if (
  //   isDeceasedAvailable &&
  //   declaration['deceased.verified'] !== 'authenticated'
  // )
  //   updatedFields['deceased.verified'] = await mosipInteropClient.verifyNid({
  //     dob: declaration['deceased.dob'],
  //     nid: declaration['deceased.nid'],
  //     name: declaration['deceased.name'],
  //     gender: declaration['deceased.gender']
  //   })

  // const isInformantAvailable =
  //   declaration['informant.dob'] &&
  //   declaration['informant.nid'] &&
  //   declaration['informant.name']

  // if (
  //   isInformantAvailable &&
  //   declaration['informant.verified'] !== 'authenticated'
  // )
  //   updatedFields['informant.verified'] = await mosipInteropClient.verifyNid({
  //     dob: declaration['informant.dob'],
  //     nid: declaration['informant.nid'],
  //     name: declaration['informant.name']
  //   })

  // const isSpouseAvailable =
  //   declaration['spouse.dob'] &&
  //   declaration['spouse.nid'] &&
  //   declaration['spouse.name']

  // if (isSpouseAvailable && declaration['spouse.verified'] !== 'authenticated')
  //   updatedFields['spouse.verified'] = await mosipInteropClient.verifyNid({
  //     dob: declaration['spouse.dob'],
  //     nid: declaration['spouse.nid'],
  //     name: declaration['spouse.name']
  //   })

  return h.response({ declaration: updatedFields }).code(200)
}
