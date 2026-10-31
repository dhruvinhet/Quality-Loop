import React from 'react';
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle, ModalTransition, Stack, Text } from '@forge/react';

export default function PageConfirmation({ title, lines, onCancel, onConfirm }) {
  return <ModalTransition><Modal onClose={onCancel}>
    <ModalHeader><ModalTitle>{title}</ModalTitle></ModalHeader>
    <ModalBody><Stack>{lines.map((line, index) => <Text key={index}>{line}</Text>)}</Stack></ModalBody>
    <ModalFooter><Button onClick={onCancel}>Cancel</Button><Button appearance="primary" onClick={onConfirm}>Confirm</Button></ModalFooter>
  </Modal></ModalTransition>;
}
